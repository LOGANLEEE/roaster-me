# Runbook

How to run the things that aren't `pnpm dev`. Every command here has been run against production
at least once — where one hasn't, it says so.

## Deploy

```bash
pnpm --filter @danyeowa/web build     # MUST come first: wrangler ships whatever is in web/dist
npx wrangler deploy
```

Then verify the deploy rather than trusting it — a mid-deploy fetch returns the *previous* bundle
hash, which looks exactly like a failed deploy:

```bash
curl -s "https://danyeowa.com/?cb=$RANDOM" | grep -o 'index-[A-Za-z0-9_-]*\.js'
# must match the hash printed by the build
```

**A failed web build does not stop `wrangler deploy`.** It will happily ship the worker with stale
assets. Check the build's exit status before deploying.

Merging to `main` also deploys, via GitHub Actions, after typecheck + unit + e2e.

## Database migrations

Write the migration into `drizzle/` and let CI apply it. The deploy job runs
`wrangler d1 migrations apply --remote` **before** `wrangler deploy`, so schema always precedes
the code that needs it, and applies only what `d1_migrations` has not recorded.

**Do not apply migrations by hand.** Three went in that way and were only safe because they were
additive; reversed, production breaks the moment the Worker deploys. If one ever does get applied
manually, record it in the ledger or the next automated run will try to re-apply it:

```bash
npx wrangler d1 execute danyeowa-db --remote --command \
  "INSERT INTO d1_migrations (name, applied_at) SELECT '00XX_name.sql', datetime('now')
   WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='00XX_name.sql');"
```

The preview environment **shares production's D1**. Trips added through a preview URL are real.

## Writing to production

**Scripts hold no database credentials.** Every write goes through `/api/ingest/*` on the Worker,
validated with the same schema the app reads:

| route | for |
|---|---|
| `POST /api/ingest/schedules` | harvested airports + legs (airports written first, server-side) |
| `GET /api/ingest/upcoming-arrivals` | the refresher's work list |
| `POST /api/ingest/arrival-corrections` | corrected arrival times, re-arming the alert stages |

Guarded by a bearer token. The Worker secret and the local copy must match:

```bash
export INGEST_TOKEN=...                       # or: source ~/.config/danyeowa/env
```

**Rotating: Worker first, local file second.** The reverse leaves the scripts presenting a token
production does not know, and it destroys the only copy of the old value before you have confirmed
the new one works.

```bash
umask 077                                    # or the file is world-readable before chmod runs
NEW=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
printf '%s' "$NEW" | npx wrangler secret put INGEST_TOKEN     # 1. Worker
printf 'export INGEST_TOKEN=%s\n' "$NEW" > ~/.config/danyeowa/env   # 2. local
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $NEW" \
  https://danyeowa.com/api/ingest/upcoming-arrivals            # 3. expect 200
```

`secret put` fails with `the latest version of your Worker isn't currently deployed` whenever an
open PR's `preview` job has uploaded a newer version. Merge the PR and let CI deploy, then retry.
Do not take the error's advice to deploy the latest version — that hand-deploys a preview build.

Give a rotation ~60s before trusting a probe. A fresh secret reaches edges unevenly and one `401`
in that window means nothing.

No configured token means every ingest request is refused — it fails closed on purpose.

`SELECT` against production for diagnosis is fine. `INSERT`/`UPDATE`/`DELETE` by hand is not; see
the rules in `CLAUDE.md`.

## Harvesting schedules

Fills `flight_schedules` from flightradar24's JSON API, driven by a real Chrome (a direct request
gets a Cloudflare 403).

Runs from launchd every 30 minutes, capped at 15 flights a run — see "Scheduling" below.

`--live-roster` reads the flight numbers fr24 shows airborne and accumulates them in the progress
file, instead of guessing at EK0..EK999 where ~94% of the numbers were never assigned. One sample
returns about 148 Emirates numbers; repeated runs converge on the network.

Manual forms still work:

```bash
node scripts/fetch-schedules.mjs --live-roster --limit 5              # dry-run
node scripts/fetch-schedules.mjs --flights EK247,EK373                # specific flights
node scripts/fetch-schedules.mjs --range 1-300 --apply                # numeric sweep
node scripts/fetch-schedules.mjs --live-roster --retry-missing        # re-check empties
```

- Dry-run records no progress; only `--apply` marks a flight done.
- `--force` re-does flights **without** wiping the file. It used to erase the whole bookmark.
- Writes flush every 5 flights, so an interrupted run keeps what it got.
- Progress is `scripts/.fetch-progress.json` — `done`, `missing`, and `roster`. **`missing` is not
  proof a flight doesn't exist**: fr24 has real coverage gaps (EK41 is a daily A380 to Heathrow
  and fr24 has nothing for it).
- **The live feed rate-limits rapid repeats, and its refusal looks like success** — zero rows,
  HTTP 200, non-zero `full_count`. That is treated as throttled and retried; don't "fix" it by
  reading zero rows as an empty sky.
- Expect ~15s per flight: roughly every second request gets a Cloudflare challenge, costing a
  retry behind a fresh context.
- **It writes airports too, and must.** The lookup route 404s a flight whose leg references an
  IATA the `airports` table has no row for, because it will not guess a timezone. Harvesting
  schedules alone put 14 flights in the database that the app could not serve, EK247 among them.
  Check for a recurrence with:

```bash
npx wrangler d1 execute danyeowa-db --remote --command \
  "WITH codes AS (SELECT origin AS iata FROM flight_schedules UNION SELECT dest FROM flight_schedules)
   SELECT count(*) AS unseeded FROM codes WHERE iata NOT IN (SELECT iata FROM airports);"
```

## Refreshing arrival times against reality

Corrects stored arrival times against live flightradar24 data, and clears `arrival_alert_stage`
so the 60/30/0 alerts re-arm against the corrected time.

```bash
node scripts/refresh-arrivals.mjs --hours 12        # dry-run
node scripts/refresh-arrivals.mjs --apply           # writes to prod D1
```

Runs from launchd, not cron — see "Scheduling" below.

**Two things together get past fr24's bot check, and only together.** Measured: a plain Playwright
context gets 403 whether headless or headed; borrowing the real Chrome cookies still gets 403;
adding the automation-marker flags is what finally works.

- the real profile's cookies, copied to a scratch dir so Chrome can stay open
- `--disable-blink-features=AutomationControlled`, `ignoreDefaultArgs: ["--enable-automation"]`,
  and `navigator.webdriver` stubbed

Runs headless, so a cron job throws no windows at you. It only rewrites a time when the drift is
at least 10 minutes — every flight is a minute or two off its timetable and churning the row for
that would re-arm alerts for nothing.

Verified end to end against a live EK4: stored 23:35Z corrected to 02:50Z from the airborne
estimate, and the stage reset from 30 to NULL.

If fr24 tightens the check, the fallback is the API at $9/month, which removes the browser
entirely — for this and for the harvester.

**Cloudflare answers a concurrent D1 request with 7403 "account is not valid or is not
authorized".** It reads like a dead credential and is not — the same command works moments later,
and the harvester writing at the same time is enough to cause it. Both scripts retry; don't go
looking for a broken token when this appears in a log.

## Scheduling

Both background jobs are launchd user agents, not cron entries:

| Label | Interval | Log |
|---|---|---|
| `com.danyeowa.refresh-arrivals` | 900s | `/tmp/danyeowa-refresh.log` |
| `com.danyeowa.harvest` | 1800s | `/tmp/danyeowa-harvest.log` |

`StartInterval` is the reason for the switch. **cron simply skips a slot the machine slept
through; launchd runs the missed interval once it wakes.** Measured on the cron setup: 1 skipped
run in 39, which matters most at the exact moment it hurts — the last check before a landing.

```bash
launchctl list | grep danyeowa                              # loaded?
launchctl kickstart -p gui/$(id -u)/com.danyeowa.harvest    # run one now
launchctl bootout gui/$(id -u)/com.danyeowa.harvest         # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.danyeowa.harvest.plist
```

Plists live in `~/Library/LaunchAgents/`. They carry an explicit `PATH` (launchd, like cron, has
no brew in it) and an absolute `WorkingDirectory`.

**The token is not in the plist.** Both run through `/bin/sh -c` and source it instead:

```sh
. "$HOME/.config/danyeowa/env" && exec /opt/homebrew/opt/node@22/bin/node <script> <args>
```

A plist is `0644` — every process on the machine can read one. `~/.config/danyeowa/env` is `0600`,
so sourcing keeps the token readable only by its owner. The `&&` is load-bearing: with `;` a
missing env file would let the job run on to hit production with no token, and the failure would
read as an auth bug rather than a missing file. Rotating the token now means editing that one
file — the plists never mention it.

## Push notifications

```bash
# Send yourself a test push — open this in the app on the phone, signed in
https://danyeowa.com/api/push/test
```

Returns `{"sent":1,...}` on success. `failedWithStatus` carries the push service's HTTP status;
404/410 means the subscription expired and it has been removed.

Alerts are driven by the Worker's cron (`*/15`), which runs both scans:

- `runReportScan` — report time, at the user's lead
- `runArrivalScan` — 60 / 30 / 0 minutes before arrival

Inspect state:

```bash
npx wrangler d1 execute danyeowa-db --remote --command \
  "SELECT flight_no, arr_utc, arrival_alert_stage FROM flights ORDER BY arr_utc DESC LIMIT 10;"
```

`arrival_alert_stage` is the smallest offset already sent — `NULL` none, `0` finished.

**A stamp is not proof of delivery.** `report_notified_at` and `arrival_alert_stage` record that a
send returned 2xx — the push service accepting the message, not a phone showing it. The only
end-to-end check is `/api/push/test` from the device itself.

First thing to check when "the alert never came": whether that account has a device at all.

```bash
npx wrangler d1 execute danyeowa-db --remote --command \
  "SELECT u.email, COUNT(ps.id) AS subs FROM user u \
   LEFT JOIN push_subscriptions ps ON ps.user_id = u.id GROUP BY u.id;"
```

On 2026-08-31 that returned one subscription across the whole database. A user with no device is
now skipped without being claimed, so subscribing later still catches an alert that has not yet
passed — before that fix, the flight was stamped and lost.

Failed sends log to Workers Logs (`observability` is on in `wrangler.jsonc`):

```
[push] send failed status=<http status> host=<push service host>
```

Endpoint host only, never the full URL — its path segment is the subscription's bearer credential.

If wrangler picks the wrong account (`code: 7403`, "not authorized to access this service"), the
account has to be named explicitly — this login can see four:

```bash
export CLOUDFLARE_ACCOUNT_ID=08d39249abaa892047690aa4c0c34b3a
```

## Local sign-in

`logan@example.com` / `123123`. Any other address gets a random code, readable at
`/api/__e2e/last-otp?email=…`.

## When a change seems to have no effect

A stale `wrangler dev` keeps the port and serves an old bundle. `workerd` can respawn after its
parent dies — kill the parent, then the child, then confirm the port is free.

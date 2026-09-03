# Roadmap

What is decided, what is pending, and what each pending thing is blocked on. Newest decisions
live in `DECISIONS.md`; what exists today is in `FEATURES.md`. This file is only for **work not
yet done**, so a new session can pick up without re-deriving the context.

Last updated 2026-08-13.

---

## Who this is for (the thing every decision below serves)

The app was built because **one partner is cabin crew and the other is not**. Her airline forbids
screenshotting the roster app, so today the schedule reaches him as a few dates typed into
WhatsApp — which he misses or forgets. He needs to know: when she reports, when she lands (he
picks her up), and which days are free, so dates can be planned. The roster updates **once a
month**.

So the primary reader of this data is **the partner, not the crew member**. Anything that only
serves the crew member is secondary. If a feature makes the partner's question harder to answer,
it is wrong regardless of how good it looks.

Later, possibly: the same pain for any shift worker's household. Not scoped, not designed, not
promised — do not build for it yet.

---

## 1. Email that actually reaches people — DONE 2026-08-13

**Why it matters:** crew sharing is live, but an invited person cannot sign in unless they use
Google. Production OTP mail only ever reached the Resend account owner's own address, because the
sender was `onboarding@resend.dev` (Resend test mode). Verified: a code sent to
`korlogan94@gmail.com` arrived; the same code to `korlogan94+crewa@gmail.com` never did.

| Step | State |
|---|---|
| Buy a domain | ✅ `danyeowa.com`, Cloudflare Registrar, $10.46/yr |
| Resend account for this app | ✅ separate free account (hellogenietour.com occupies the other one — free tier is 1 domain, 3,000/mo, 100/day) |
| DNS records | ✅ auto-added by the Resend↔Cloudflare integration. Confirmed live by `dig`: DKIM `resend._domainkey`, SPF + MX on `send` |
| Resend domain status | ✅ **Verified** (region Tokyo `ap-northeast-1`) |
| `RESEND_API_KEY` secret | ✅ set as version `67833aa2` (not deployed — see the versions trap below) |
| `EMAIL_FROM` secret | ✅ `danyeowa <noreply@danyeowa.com>`, version `e69c5f84` |
| Deploy + prove delivery | ✅ PR #46 merged (`c43bafa`), CI deployed. OTP to `korlogan94+danyeowa1@gmail.com` arrived from `noreply@danyeowa.com` — the alias that got nothing for 7 days |

**A plain `wrangler deploy` keeps the secrets.** `versions secret put` writes the secret into a
new, undeployed version; the CI deploy that follows uploads its own version from source and
inherits every existing secret. Confirmed: `wrangler secret list` shows all six, and the OTP mail
sent after the deploy used the `EMAIL_FROM` value.

**The versions trap.** `wrangler secret put` fails with *"the latest version of your Worker isn't
currently deployed"* whenever a PR preview has uploaded a newer version (our CI does this on every
PR). Use `wrangler versions secret put <KEY>` instead — it stores the secret in a new,
undeployed version, and the next CI deploy carries it.

---

## 2. Stop storing OTPs in plaintext — DONE 2026-08-13

`verification.value` holds the OTP as `616087:0`. Anyone with read access to production D1 can
sign in as any user. This is how the production crew test in this session was run at all, so treat
it as proven, not theoretical.

Fixed by `emailOTP({ storeOTP: "hashed" })` in `worker/src/auth.ts` — a first-class better-auth
option (`plain` is the default; `encrypted` and custom hashers also exist), available in the
1.6.26 already installed.

Guarded by a test that was **proven failing first**: it read `verification.value` straight out of
D1 and asserted the plaintext code was not in it — `expected '981077:0' not to contain '981077'`
before the change, green after. The same test signs in with the plain-text code afterwards,
because hashed storage is only worth having if verification still works.

Ordering held: §1 delivered mail before this landed, so email sign-in was never the only casualty.
Nothing reads `verification.value` outside better-auth — the dev and e2e OTP paths read
`getLastDevOtp()` from Worker memory, not the database, so both still work.

---

## 3. Move the Worker to the `danyeowa` account — DONE 2026-08-14

Today the Worker + D1 sit in **Logan personal account**; `danyeowa.com` sits in a separate
**danyeowa** account created by the domain purchase. A Workers custom domain needs the zone and
the Worker in the same account.

The domain **cannot** move for now: Cloudflare blocks account transfer for 10 days after
registration (the Settings page says so outright, button disabled) — eligible **after
2026-08-23**. Moving the *Worker* instead is possible today, and is the chosen direction.

**Target URL: `danyeowa.com` (apex).** Shortest to say, one string for site and email, and the
PWA is the whole product so there is nothing else to put on the apex. Cost: if a marketing page
ever wants the apex, the app moves to a subdomain and URLs break again — accepted.

### What breaks, and who must fix it

1. **All sessions log out** — cookies are host-bound.
2. **All push subscriptions die** — subscriptions are origin-bound. Rows in `push_subscriptions`
   become dead; everyone re-subscribes on the new origin.
3. **Every share link already sent breaks** — the token survives in D1, the host does not.
4. ~~Google sign-in breaks until the redirect URI is added~~ — **done 2026-08-13.** The OAuth
   client now lists all three: the workers.dev URL, `http://localhost:8787`, and
   `https://danyeowa.com/api/auth/callback/google`. The old workers.dev entry was kept on
   purpose, so the old Worker can stay up as a redirector and so a failed cutover has a way back.
5. **CI deploy breaks until `CLOUDFLARE_API_TOKEN`** in GitHub is swapped for a danyeowa-account
   token. **User task.**
6. ~~The local harvester breaks~~ — **done 2026-08-19.** Neither the env file nor the plists
   ever carried an API URL; `scripts/lib/ingest-client.mjs` defaults to `https://danyeowa.com`.
   The config dir and the launchd labels were renamed to `danyeowa` in the same pass.
7. ~~wrangler CLI cannot see the danyeowa account~~ — **done 2026-08-13**, `wrangler login`
   re-run with that account granted. Confirm with `wrangler whoami` before relying on it.

### Sequence

**Prep (no downtime)** — merge the rename PR first so production is current; grant CLI access to
the new account; create the D1 there and apply migrations; export/import once as a rehearsal.

**Cutover (~10 min)** — re-export production D1 (`wrangler d1 export … --remote`, 258 kB, ~800
rows) and import into the new one; set all five secrets (`BETTER_AUTH_SECRET`,
`GOOGLE_CLIENT_SECRET`, `INGEST_TOKEN`, `RESEND_API_KEY`, `VAPID_PRIVATE_KEY`); update
`wrangler.jsonc` with the new `database_id`, an explicit `account_id`, and
`BETTER_AUTH_URL: "https://danyeowa.com"`; deploy; attach the custom domain; then the four user
tasks above.

**After** — decide whether the old Worker stays a few days as a redirect to the new domain (saves
old share links and installed PWAs) or is deleted outright. Delete the old D1 only after the new
one is verified through the API, not by looking at row counts.

### Prep done 2026-08-13 (no downtime, nothing cut over)

Backups now live in `~/.local/share/danyeowa-backups/`, not a session scratchpad — the previous
one was written somewhere a later session could not reach. Current: `d1-prod-20260813-2030.sql`,
233 kB, 788 inserts, 13 app tables plus `d1_migrations`. **Still take a fresh one at cutover.**

`danyeowa-db` exists in the danyeowa account, id `2569ddab-ffe2-4734-931e-234a294e6a07`, loaded
from that export and verified against production by row count — `user=8 account=3 session=16
trips=10 flights=12 flight_schedules=568 airports=149 crew_invites=3 share_links=1
push_subscriptions=1`, identical on both sides.

**A D1 export does not import back into D1 as-is.** Three things bite, all found by doing it:

1. The export orders `account` before `user` and `flights` before `trips`, and D1 ignores the
   `PRAGMA defer_foreign_keys=TRUE` the export writes on line 1. A straight
   `d1 execute --file <export>` dies with `no such table: main.user`, then with
   `FOREIGN KEY constraint failed` once the tables exist. Split the file into schema and data,
   then load the data parents-first: `user` before `account`/`session`/`trips`/`share_links`/
   `notification_prefs`/`push_subscriptions`/`crew_invites`, and `trips` before `flights`.
2. `d1 execute --json --file` returns `{"error":{"text":"{\"D1_RESET_DO\":true}"}}`. Use
   `--file` for bulk load, `--command` for anything whose output you want to read.
3. D1 caps compound SELECT terms: a ten-way `UNION ALL` of `COUNT(*)` fails with
   `too many terms in compound SELECT [code: 7500]`. Use scalar subqueries in one SELECT instead.

### The secrets are write-only — this is the real cutover blocker

A new Worker in a new account needs all five secrets re-supplied, and Cloudflare will not read
them back. Where each one actually comes from:

**There are SIX, not five.** This list said five and the sixth cost a debugging cycle: with
`EMAIL_FROM` unset, `sendOtpEmail` silently falls back to `DEFAULT_FROM`
(`danyeowa <onboarding@resend.dev>`) — Resend test mode, which delivers only to the Resend
account owner's own address. That is the §1 bug exactly, reintroduced by the move. Count the
old Worker's `wrangler secret list` before trusting any list in a document, including this one.

| Secret | Source | Who |
|---|---|---|
| `RESEND_API_KEY` | **nowhere on disk.** Must be re-created in the Resend dashboard | **user** |
| `EMAIL_FROM` | `danyeowa <noreply@danyeowa.com>` — a plain string, not a credential | either |
| `GOOGLE_CLIENT_SECRET` | `.dev.vars` (same OAuth client as production) | either |
| `INGEST_TOKEN` | `~/.config/danyeowa/env` — must keep the same value or the harvester breaks | either |
| `BETTER_AUTH_SECRET` | regenerate; sessions die in the move anyway | either |
| `VAPID_PRIVATE_KEY` | regenerate via `scripts/generate-vapid.mjs --put`; the public half goes in `wrangler.jsonc`, and push subscriptions die in the move anyway | either |

### Setting `RESEND_API_KEY` without breaking it

Three attempts failed before this stuck, all for avoidable reasons.

**The key you can see is not the key.** Resend's API-keys table shows a truncated
`re_VMufX4Mr…`, about 15 characters. A real key is **36**. The truncated one looks plausible,
authenticates as nothing, and produces zero rows in Resend's own log — indistinguishable from a
Worker that never called out. The full value appears once, in the creation dialog, and is never
shown again. Check before setting:

```
pbpaste | tr -d '[:space:]' | wc -c      # 36 = real key, ~15 = you copied the table
```

**Pipe it, never paste it into a prompt.** `pbpaste | tr -d '[:space:]' | wrangler secret put …`
strips stray whitespace and removes the manual paste, which is where the value gets mangled.

**`wrangler secret put` is refused whenever a newer undeployed version exists** —
*"the latest version of your Worker isn't currently deployed"*. Any earlier `versions secret put`
leaves exactly that state. The full sequence:

```
pbpaste | tr -d '[:space:]' | npx wrangler versions secret put RESEND_API_KEY --name danyeowa
npx wrangler versions deploy <new-version-id>@100 -y
```

`versions secret put` alone is **not** enough: it creates the version but leaves it serving no
traffic, so nothing changes until you deploy it.

**A plain `wrangler deploy` inherits secrets from the LATEST version, not the deployed one.**
This cuts both ways and has done both here: it is how `EMAIL_FROM` reached production through CI,
and it is how a non-working key would have been dragged back in at the next merge after a
rollback. After any rollback, check that the newest version holds a value you have tested.

### Diagnosing a send that goes nowhere

`POST /api/auth/email-otp/send-verification-otp` returns **200 whatever happens** — better-auth
swallows the transport error, and `wrangler tail` shows `outcome: ok` with an empty `exceptions`
array. Neither is evidence of delivery. Two instruments that actually see it:

- **Resend → Logs.** One row per API call. *No row at all* means the Worker's request never
  authenticated against that account — a dead or foreign key — rather than a rejected send.
- **The recipient's inbox.** The only proof. Prove the search itself first: query
  `from:noreply@danyeowa.com newer_than:2d` and confirm it finds a mail you know arrived, before
  reading an empty result as a failure.

Plus the two GitHub secrets: `CLOUDFLARE_API_TOKEN` (a danyeowa-account token, **user**) and
`CLOUDFLARE_ACCOUNT_ID` → `08d39249abaa892047690aa4c0c34b3a`.

---

## 4. The partner cannot see times — THE ACTUAL PRODUCT GAP

Still the reason this app exists, and still unsolved. **The share link was deleted on 2026-08-14**
(see `DECISIONS.md`), so right now a partner without an account sees nothing at all — a deliberate
regression, on the grounds that a link showing the wrong things was not worth designing around.

The invite is now the only sharing mechanism, and it already carries every time:
`GET /crew/:userId/trips` returns the full roster. What it does not have is a shape suited to
someone who is not crew.

### Decided so far

- **The recipient may have no account.** Invite an address; if they never sign in they still get a
  useful view. Signing in makes the grant personal and revocable.
- **Times render in the viewer's own timezone.** Consistent with `deriveHeroStatus`, which already
  resolves against `viewerTz`. The payload should carry UTC instants and let the client format.
- **`crew_invites` is misnamed.** The recipient may be a partner or a parent. Rename the table,
  routes and UI as part of this work.

### Open, and blocking a spec

- **Who picks the tier.** Making "signed up" the thing that unlocks the full roster lets the
  recipient grant themselves more access than the sender intended. The alternative is the sender
  choosing a level per invite, with sign-in changing only revocability. Not settled.
- **What each tier shows.** The candidate limits are: current month only, no past, no flight
  numbers.

### Still wanted, unchanged

1. **Report time and landing time** wherever the partner ends up reading.
2. **Landing alert to the partner** — the staged alerts (60 min, 30 min, touchdown) already exist
   in `flights.arrivalAlertStage`; only the delivery to a non-account holder is missing.
3. **A "next days off" view** — free days are currently something you infer from gaps in a grid.

---

## 6. Which sector is hers — DONE 2026-08-16

Shipped per `docs/superpowers/specs/2026-08-15-operating-sector-design.md`.

EK205 is DXB → MXP → JFK and the crew can change at Milan. The app stored every leg the schedule
returned, so someone finishing at MXP was recorded as landing at **JFK 18:55** instead of
**MXP 14:10** — wrong in the one number this app exists to get right.

The add form now asks *"Where do you get off?"* whenever a lookup returns more than one sector.
Later sectors are kept, marked `operating = false` (migration `0014`), and the API partitions them
out of `flights` into `continuation`. That split is the safety mechanism: six places derive times
from legs, and a consumer that has never heard of this feature still reads only her sectors.

`report-scan.ts` is the one place the split does not reach — it queries `flights` directly by
`reportUtc`/`arrUtc` with no trip context — so it filters explicitly. Both its queries carry a
test proven failing first (`expected 1 to be +0`: a push for a landing she is not on).

Only sectors she actually worked are reported back to the crowd-sourced schedule layer; she cannot
vouch for times on a leg she was not on. `scheduleLegSeq` is never re-indexed.

**Still open:** whether the partner's view should mention the onward routing at all. Moot until
§4 builds a partner view, and the spec leans towards no.

---

## 5. Smaller open items

- **KIPRIS trademark check for 다녀와 is unverified.** The search page is a JS SPA; a scrape
  returned zero results, which is indistinguishable from the query never running. Matters only if
  the mark is ever filed — the domain itself is fine.
- ~~**Cloudflare Email Sending needs Workers Paid ($5/mo).**~~ **Closed 2026-09-02 — not doing.**
  Resend covers both sends on its free tier and nothing has stopped fitting. Google-only sign-in
  was raised as a way to drop mail entirely; it cannot. `worker/src/email.ts` has two send sites,
  and only one of them is a sign-in: `sendOtpEmail` (`auth.ts:5`) and `sendCrewInviteEmail`
  (`crew.ts:6`). The invite goes to someone who has no account yet, so no OAuth provider can
  deliver it. Dropping OTP would also break local dev, every PR preview (Google needs exact
  redirect URIs, and each preview is a new hostname) and all of e2e, which signs in through
  `e2e/helpers.ts`.
- **Stale worktrees and branches** — re-measured 2026-09-02: `git worktree list` shows only the
  repo itself, so the `roster-me-worktrees/*` four and the `~/.cursor` one named here are already
  gone. What is left is one merged local branch, `fix/drop-the-duplicate-board`, plus merged
  branches on origin. Left alone on purpose; delete only on the user's say-so.

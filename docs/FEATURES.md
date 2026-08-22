# What danyeowa does

A running inventory of what is actually built, so a new session doesn't have to re-read the
codebase to find out. Status words mean exactly one thing:

- **Live** — in production, and verified working there, not just green in tests.
- **Built** — merged and deployed, but never confirmed against reality.
- **Partial** — works within a stated limit; the limit is named.
- **Not built** — deliberately, with the reason. See `DECISIONS.md` for the argument.
- **Unmerged** — written and tested, sitting on a branch. Not in production, no matter how done it
  looks in the code.

---

## Roster

| Feature | Status | Notes |
|---|---|---|
| Month calendar with duty markers | Live | Glyph + station per day: `↗BKK` out, `↙AKL` back, `⇄BKK` turnaround, `→` sector, `·` layover |
| Swipe between months | Live | Finger-following carousel (PR #40): prev/next months render either side, the track follows the drag and settles on release. 50px threshold, cancels on vertical intent |
| Tap a day to see the trip | Live | One tap. No bottom sheet — it was deleted, see DECISIONS |
| Add a trip inline on an empty day | Live | Flight-code input appears immediately; airline prefix is a setting, digits only |
| Turnarounds in one save | Live | Second flight appends to the same preview before saving |
| Edit / delete on the card | Live | Pencil and bin. Editing is create-then-delete, never the reverse |
| Trip detail with leg timeline | Live | Report → depart → land, with layovers between sectors — on the day card, which is the only trip surface now |
| Manual entry when a lookup misses | Live | Only appears after a lookup actually returns empty |
| More than one duty on a day | Live | A turnaround in the morning and a standby that evening are separate trips, not legs. The day card stacks one card per duty, each with its own edit and delete. `tripsForDay()` returns a list; it used to return the first match and stop, which made a second duty invisible |
| Delete asks in a modal | Live | Native `<dialog>` + `showModal()`, so Esc, focus trap and inert background come from the platform. jsdom implements none of it, so the behaviour is only ever real in e2e |
| Which sector is actually hers | Live | A multi-sector service (EK205 DXB→MXP→JFK) can change crew down-route. Non-operating legs are stored so the routing stays true but split out of `flights` into `continuation`, so a consumer that forgets the flag still gets the right times |
| Layover days marked | Live | Days between two trips of one pairing — she is in EZE, not at home. Computed base-to-base across trips, drawn as one continuous band. See `DECISIONS.md` 2026-08-18 |
| Transit told apart from a layover | Live | A stop under 6h free is transit, not a layover: the timeline says so and no rest panel appears. EK247's two hours at Rio used to offer a city guide and "5m free until report" |
| Turnaround named on the card | Live | Out of base and back the same local day |
| The next-duty card carries the detail | Live | Timeline, weather and glyph, not just the board rows — the home screen used to hide all three behind a tap with nothing saying so |
| Animated weather mark | Live | Falling rain, drifting cloud, turning rays, a storm flash. `transform`/`opacity` on small nodes only, and static under reduced motion |
| The flight card wears the destination's sky | Live | When a forecast exists for the landing day, the day-detail card's surface becomes that weather — five fields (clear, cloud, rain, storm, snow), dark in both themes because a light sky drops the report time to 3.5:1. No forecast, plain card. See `DECISIONS.md` 2026-08-22 |
| Destination forecast on a layover | Live | Open-Meteo, free and key-less, keyed on the `lat`/`lng` seeded from OurAirports. Only ever a real forecast: the API reaches about 16 days and a roster runs further, so beyond that the card says so instead of drawing a seasonal average. Attribution on the card (CC BY 4.0) |
| Send a test notification | Live | Settings → Notifications. `GET /api/push/test` existed from the start with nothing calling it; the counts it returns are what tell "never sent" apart from "sent, device swallowed it" |
| Sunset and city pointers on a layover | Live | Sunset rides along with the forecast already fetched — on a layover the question is how much light is left. Two outbound links (Wikivoyage city guide, a what's-on search) instead of mirroring either dataset into this app. See `DECISIONS.md` 2026-08-21 |
| Layover brief, copied for an assistant | Live | On any day inside a down-route rest: how long she is free (landing → next **report**, not next departure — a 25h layover with a 19:40 report is 22h 35m of usable time) plus a button that copies the roster context as a prompt. Optional hotel field, never stored. See `DECISIONS.md` 2026-08-21 |
| Today told apart from the tapped day | Live | Today fills the number in `--color-today`; selection rings the cell. They used to be the same colour and shape, one pixel apart |

## Notifications

| Feature | Status | Notes |
|---|---|---|
| Report-time alert | Built | Fires at the user's lead (default 120 min) before report |
| Arrival alerts, 60 / 30 / 0 min | Live | Verified in production on a real EK373 arrival, delivered to an iOS PWA |
| Arrival alerts on/off in Settings | Built | `notification_prefs.arrival_enabled`, independent of report alerts |
| Lead time 30–360 min | Built | Applies to report alerts only; arrival stages are fixed |
| Self-test push | Live | `GET /api/push/test` sends to the caller's own devices |
| Delay / early-arrival tracking | Built | `scripts/refresh-arrivals.mjs` on a Mac cron corrects `arr_utc` from live data and re-arms the alert stages. Verified on an airborne EK4 |

## Schedule data

| Feature | Status | Notes |
|---|---|---|
| Flight lookup by number | Live | Cache-first from `flight_schedules`, then the provider chain |
| Multi-leg services | Live | EK247 = DXB→GIG→EZE as two legs of one service |
| Local harvester | Live | `scripts/fetch-schedules.mjs` — real Chrome, fr24 JSON API, writes prod D1. On cron at :05/:35, working from the live roster |
| Negative cache for misses | Partial | Still records a miss when the fetch was *blocked*, which poisons a live flight for the TTL |
| Live flight status (ETA) | Built | Needs the Mac awake. Real Chrome cookies + automation markers off; see RUNBOOK |

## Account and sharing

| Feature | Status | Notes |
|---|---|---|
| Email OTP sign-in | Live | Fixed dev code locally; unreachable in production |
| Google sign-in | Live in prod only | Cannot work on localhost or preview URLs — Google needs exact redirect URIs |
| Share a roster by link | **Removed 2026-08-14** | `/share/:token` and the `share_links` table are gone. It carried no clock times, and a bearer URL is the wrong place to put them — see `DECISIONS.md`. The invite is now the only way to share |
| Crew sharing (per-person) | Live | Invite by email on the Share tab (now the only thing on that tab); once accepted, both sides read each other's calendar through the badge row. Read-only in both directions — no write route takes a user id. Verified in production 2026-08-13 with two throwaway accounts: invite → accept → cross-read → revoke, zero mutation controls on the other roster, rows cleaned up after |
| The invitation is emailed | Live | Resend, from `noreply@danyeowa.com`. Awaited, not fire-and-forget: the response carries `emailed`, so a silent send failure cannot leave the sender believing someone was told. The invite still stands if mail is down. Verified by reading real delivered mail |
| Invite link explains itself | Live | `/invite/:token` shows who invited you and a fabricated, blurred sample calendar before asking for anything. The route returns two strings and no schedule data, so the token cannot leak a roster |
| Wrong-account sign-in is explained | Live | `matchesYou` (boolean only, server-side comparison) tells a signed-in visitor whether this session is the invited one, instead of dropping them into an app with no invitation and no reason given |
| Deploys prove themselves | Live | `/api/health` reports the commit it was deployed from; the deploy job polls production for that commit *and* the asset filename it built before going green |
| Delete your account | Live | Settings → danger zone. Confirmed by typing your own address into a native `<dialog>`. Removes the `user` row; roster, crew links, push subscriptions and sessions follow by ON DELETE cascade — measured, not assumed |

## App shell

| Feature | Status | Notes |
|---|---|---|
| PWA install | Live | Install button where supported, iOS gets the Share → Add to Home Screen hint |
| Install nudge banner | **Unmerged** | PR #31 |
| Dark / light theme | Live | Semantic tokens only, no raw hex outside `tokens.css` |
| Zoom disabled app-wide | Live | Requested explicitly; 16px floor on controls is what actually fixes the iOS layout bug |
| Offline / service worker | Built | Push delivery depends on it |
| Boot splash | Live | Boarding-pass stub in `index.html`, dismissed by `#root:not(:empty)` alone — one DOM node from first paint to first view |

## Deliberately not built

Destination news · async schedule reconciliation · a second D1 for previews · a leg chooser
for multi-leg flights. Reasons in `DECISIONS.md`. (Destination weather WAS on this list until
2026-08-21, when the `lat`/`lng` column it was blocked on finally landed; sunset rides along in
the copied brief but has no tile of its own.)

## Deliberately removed

- **Trips tab** — a second list of the duties the calendar already shows, one row per leg, which
  read as a chart of unranked things. Deleted 2026-08-13 along with the full-screen trip detail it
  was the only way into.
- **Leg-level time editing** — went with that detail screen, and `PATCH /api/flights/:id` went with
  it on 2026-08-13 once nothing called it. `LegPatchSchema` went too.
- **Scroll-to-expand duty timeline** and the **DaySheet**. See `DECISIONS.md`.

---

## Known limits

**Live status depends on a Mac being awake.** Arrival corrections come from a launchd agent on
this machine, because fr24's live endpoints refuse a Cloudflare Worker and a direct request alike.
While the Mac sleeps nothing runs; launchd fires the missed interval on wake, so a nap costs a
delay in the correction rather than losing it, and a long sleep still leaves alerts on the
timetable — correct for an on-time flight, early for a delayed one.

The escape is the fr24 API at $9/month: the Worker would call it directly, and both the refresher
and the harvester would stop needing a browser at all.

~~The negative cache records a miss when a fetch was blocked~~ — **fixed 2026-08-12.** Providers
now report `absent` (answered, no such flight) separately from `unavailable` (blocked, timed out,
no key), and only `absent` is cached.

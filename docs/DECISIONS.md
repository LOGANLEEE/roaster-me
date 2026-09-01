# Decisions

Why things are the way they are — so a new session (or a future you) doesn't re-litigate settled
questions or re-break fixed ones. Newest first. Plans 1–10 are in `docs/superpowers/plans/`.

A decision belongs here when reversing it would need a reason, or when the *rejected* option looks
obviously better until you know what's underneath it.

---

## 2026-09-02 (two flights in one day was never impossible, and a landing page that says so)

### The crew member's own account, and what it cost

Isis flew DXB → SEZ → TNR, typed EK707, and concluded the app could not take two flights in one
day. So she recorded the first sector only, and split the way home across two separate days. Her
24–27 Sept rows are not contradictory — they are INCOMPLETE, and the app was faithfully rendering
what it had.

Verified in code, not inferred. `AddTripForm.tsx:138` sets
`preview = entry.autofillLegs && entry.autofillFlightNo ? … : null`, and every multi-sector
control on the form is gated on `preview`:

- `preview && preview.length > 1` → "Where do you get on?" / "Where do you get off?"
- `preview && !entry.appendedFlightNo` → the "+ add flight" append control, which its own comment
  restricts to schedule-known flights with no manual fallback

EK707 and EK708 have **zero rows** in `flight_schedules` (25 rows total). So on that lookup every
multi-sector affordance vanished at once, and what remained was one muted underlined link reading
"enter manually" — 20px tall, under the 44px touch floor this project otherwise keeps. Behind it,
the manual form has had an "Add leg" button all along.

The capability existed. Nothing said so. Fixed by saying so, in the miss state itself, and by
making the way in a real button.

### The pricing page has no images, and that is not a shortcut

Every screenshot of this app is a screenshot of somebody's real roster. The two things worth
showing — a report time and a route — are text. A picture of text loads slower, cannot be
translated, and reads as nothing to a screen reader. `LandingPitch.tsx` is text and tokens only.

Not shown to a visitor arriving on an invite link. They came because a named person shared a
roster with them; answering that with a pricing table replaces an answer with a pitch.

Prices are placeholders and say so on the page. What the shape claims: a free tier genuinely
usable alone, with payment attached to SHARING, because that is the part that costs a push
subscription and a second person's reads.

### The hero board was arguing with the copy underneath it

The signed-out departure board led with `REPORT 08:45`. Report came off the day card in `829b673`
precisely because a crew member reads it in her airline's own app — and the pitch now says that in
so many words, two hundred pixels below. The board now shows `DEP / LANDS / FREE 22h 35m`: what
this app adds rather than what it duplicates.

---

## 2026-09-01 (the roster she was reading survives a reload)

### Whose calendar is on screen is now persisted, and restored optimistically

`viewingUserId` started at `null` on every mount, so reopening the app snapped back to her own
calendar even when the whole previous session had been spent following someone else's. Following
another roster is the entire point of the crew feature, and it was being undone once per launch.

Restored from `localStorage` **before** the crew list lands, deliberately. Waiting for `getCrew`
would put a round trip in front of every cold start, including the common case of no crew at all.
The revoked-pairing risk is already handled: a crew read for a dead pairing 404s and `refetch`'s
catch falls back to her own roster — the same path a mid-session revoke takes, which was already
tested. A stale id cannot leak anything, because every crew read is authorised server-side against
the pairing; `CrewBadges` says as much already.

A second guard covers the quieter case: if `getCrew` succeeds and simply does not name the stored
id, fall back. That also handles a **different account signing in on the same device**, since the
crew list is fetched for whoever is signed in now — no user-scoped storage key needed.

Switching back to her own roster **clears** the key rather than storing a sentinel, so "never
chose anyone" and "chose herself" read identically on the way back.

### The test suite had a hidden ordering dependency, and this change exposed it

Two failures appeared that had nothing to do with the feature:

- `localStorage` is shared for a whole test FILE in jsdom, so a test that tapped a crew badge left
  the next test mounting onto that crew member's roster. It surfaced as
  `resolveOwn is not a function` — the mount called `getCrewTrips` where the test had stubbed
  `getTrips`. Fixed by clearing storage in `afterEach`.
- `vi.mocked(getCrew).mockResolvedValue(...)` replaces the implementation permanently, and
  `mockClear()` does not undo it. Every test after a crew test inherited a crew member, and the
  suite only passed because of the order the tests happened to be written in. `afterEach` now
  restores the module mock's stated default of no crew.

Worth recording because both were pre-existing and neither was anyone's bug until a new test ran
in a new position. Order-dependent suites pass until they don't.

---

## 2026-09-01 (the card answers first, and `operating` means what the renderer says it means)

### The read-only preview card is gone, and so is the empty state that echoed it

`next-duty-card` was the only surface on the calendar tab that could not be edited or deleted — a
read-only echo of a day, stacked under the pairing strip while no day card showed at all. It is
deleted. Today is now the card's default day, so a day card always renders, and the one thing the
preview uniquely answered ("when do I fly next") is answered by the empty-day card's own
`next-duty-line`, carrying the whole route chain rather than the first sector.

The "No trips yet — add your first" panel went with it. Its button did exactly one thing,
`setSelectedIso(today)`, and today's card — with the flight-number box already on it — is what
renders there now. The panel asked for a tap to reach a screen that was already underneath it.
Three e2e specs used its text as a "signed in, empty roster" marker and were retargeted at the day
card.

### Today is a DERIVED default, never written into state by an effect

The first version selected today in a `useEffect` once the roster landed. That loses taps. React
flushes passive effects *after* the commit that paints the grid, so a tap landing in that gap is
overwritten by today — measured with probes, which logged `pick 2026-08-20` and then
`effect-sets-today`, in that order, and the add went onto the wrong card.

`const shownIso = selectedIso ?? localDateKey(now.toISOString(), homeTz)` cannot race a tap: once
`selectedIso` is set, it wins. Restoring the effect fails **19 of 43** CalendarHome tests,
deterministic across five runs — so the derivation is guarded, not merely tidier.

Switching to a crew member's roster still drops the selected day (it belongs to the roster being
left) but now falls back to today rather than to nothing. There is no screen in the app without a
day card.

### `operating = 0` means she is NOT ON THAT AEROPLANE — and I asserted the opposite first

Recorded because the wrong version was confident and briefly acted on. A leg with `operating = 0`
is the aircraft's own routing, before she boards or after she gets off. Three sources, none of
which is the field's name:

- `web/src/api.ts:18` — continuation is "the legs it flies on **after she gets off**"
- `web/src/TripLegsPanel.tsx:56-64` — renders them as "Aircraft arrives before you board" /
  "Aircraft continues without you"
- `web/src/useTripEntry.ts:389-396` — `operating` is the contiguous range between
  `boardingLegIndex` and `finalLegIndex`

So **`layoverRests` is correct.** Its `inbound.dest !== outbound.origin` guard fires exactly when
the roster does not record how she got between two stations, which is what its comment says. Do
not "fix" it. The earlier claim that it hid a layover night came from reading the field name and
the worker's partition and never opening the component that renders the value — two reads sharing
one lineage is not confirmation.

What IS wrong is data: the 24–27 Sept rows are mutually impossible (24th leaves her at SEZ, 25th
boards her at TNR, with nothing carrying her there). Unresolved — ask, do not assume.

### The card's headline is different for the two people who read it

Measured over her real September roster, not asserted: she is home **61.9%** of the month,
down-route 25.6%, airborne 12.5%; there are six away runs of 2–4 days. And the number that decided
the design — **5 of 16 duties cross a home-local date boundary, and all five are the flight home**
(EK192, EK66, EK353, EK409, EK708).

So the day a duty is filed under is *never* the day she walks in. A card that leads with the
roster's own date answers the at-home reader's only question wrongly, every time. `DutyStatus.tsx`
therefore makes the hero **different by reader**: hers is a DURATION ("15h 45m free", "3h to go"),
his is a DATE AND TIME spelled with its weekday ("Mon 21 Sep · 13:00"). Never a "+1" to add.

Rejected on the way: a sector strip printing flight number and both clocks above the timeline.
`CalendarHome.test.tsx` counts that each time appears exactly once, and it caught the strip
immediately — it was the DEP/ARR board of `829b673` coming straight back. The block now prints no
clock the timeline owns, and a test asserts that.

**Down-route needs a rest that spans TRIPS.** Her roster stores each sector as its own trip (EK408
out and EK409 home are `isis-03e5ebf6` and `isis-cb5ed55d`), so a component handed one trip's legs
can never observe the gap between two, and the most valuable card would never have rendered.
`layoverRests` already walks every leg across every trip; its result is passed in rather than
re-derived.

### Motion: `ds-` prefix, `scaleX` never `width`

Two animations, `opacity` and `transform` only. `.ds-hero` rises (420ms, `--ease-snap`);
`.ds-bar > i` fills (760ms) by scaling on X, because width is layout and this card mounts on every
day tap. The rail's resting `scaleX(var(--ds-p))` sits *outside* the reduced-motion query, so under
reduced motion it draws at its true fraction rather than at zero.

The `ds-` prefix was checked free (0 hits) before being written. `@keyframes` names are one flat
global namespace, and `wx-*` vs `wxf-*` already collided here once at the cost of a day's work.
Verified by reading `getComputedStyle` — `ds-fill 0.76s -> matrix(0.781819, ...)` — never by
hashing screenshots, because a 3px twitch changes pixels too.

---

## 2026-09-01 (rain that reads as rain, and a helper that walked the wrong way)

### The sliding texture was the wrong primitive, not the wrong tuning

Yesterday's version translated the card's hatched `::before`. Rejected on sight — "에니메이션이
개판이야, 이걸 누가 이해해" — and the objection is correct. A `repeating-linear-gradient` is
uniform edge to edge, so moving it slides a corduroy pattern across the whole card. Nothing about
that reads as weather. **No amount of speed or opacity tuning fixes it, because the shape is
wrong.** Rain reads as SPARSE, separate streaks of different lengths falling at different speeds
with gaps between them. That is a set of nodes, not a fill.

`WeatherField.tsx` renders 18 marks for rain, 26 for storm, 20 for snow. Each gets its own
offset, length, opacity and duration from a hash of its index — deterministic, because
`Math.random()` would reshuffle the whole field on every re-render and this card re-renders
whenever the day changes or a forecast lands.

Two placement decisions that are not cosmetic:

- **`z-index: -1`, behind every word.** Rain across text is a smudge, not weather — and the
  layover panel carries its own opaque background, so marks drawn on top would sit ON it rather
  than behind it.
- **`isolation: isolate` on `.sky`.** Without a stacking context on the card, a negative
  z-index escapes behind the card's own background and the weather is invisible.

The static hatch stays exactly as it was. It is the texture-at-a-glance, it is what reduced-motion
users keep, and `WeatherField` renders nothing at all under `reduce` — no frozen dashes left lying
on the card.

**A storm is not a different texture. It is more rain, faster** (26 marks at 0.42s against rain's
18 at 0.68s).

### `pickCalendarDay` walked away from a day that was already on screen

`crew.spec` failed 3 runs out of 3, deterministically, the morning the date rolled over to
2026-09-01. Not flake, and the trace said so: the debug dump ended on **September 2028** after 24
month steps, looking for `2026-09-10`.

The calendar renders a SKELETON whenever `trips` is null — which includes the moment a crew badge
is tapped and someone else's roster starts loading. Probing a day cell then answers "not visible",
because no month is drawn yet rather than because the day is elsewhere, and the loop fired a month
step it did not need. From there the target is BEHIND the displayed month, and the loop only walks
forward.

**It had been passing on luck.** `EK412.pickedDate` was one month ahead of "today", so the
spurious step landed on the target month by accident. The moment the date rolled over and the
target became THIS month, the same step overshot it.

Fixed by waiting for `calendar-grid` before probing. 3 out of 3 failing → 3 out of 3 passing, and
the spec halved from 21s to 10.5s because it no longer walks two years.

The general shape, worth keeping: **a probe that cannot distinguish "absent" from "not rendered
yet" turns a loading state into navigation.** Wait for the container, then ask about its contents.

---

## 2026-08-31 (the weather falls)

### The sky texture moves now — and "no background animation" never meant "no motion"

The falling-weather layer carried a comment saying it was "static on purpose: CLAUDE.md allows
transform/opacity animation only, and a moving full-card background is a repaint every frame."
Right about the mechanism, wrong about the options. **The ban is on animating the background.**
This is one absolutely-positioned pseudo-element; translating it is a transform, the same thing
the calendar's month track and the weather glyph already do. The field gradients underneath never
move, so nothing repaints.

Rain, storm and snow fall. Cloud and clear do not, because they have no texture layer to move and
giving them one would mean animating a gradient — which is the thing the rule actually forbids.

**Both loops are picked so the pattern maps exactly onto itself**, which is what makes an infinite
translation seamless instead of a jump every cycle:

- rain/storm travel **32.65px** straight down. The 74deg gradient repeats every 9px along its own
  axis `(sin74, -cos74) = (0.9613, -0.2756)`; a vertical drop of `d` moves the pattern `0.2756*d`
  along that axis, so `d = 9 / 0.2756 = 32.65px` is exactly one period. The stripes are slanted,
  so falling vertically still reads as slanted rain.
- snow travels **14px**, one full cell of the 14px dot grid.

Storm is rain at 0.62s against rain's 1.15s — same texture, harder.

**The bleed is vertical only, and that is not a style choice.** The first version bled `-48px` on
every side so the layer never ran out of texture, and measured **+41px on
`document.scrollWidth` at 390px** — a horizontal scroll, which this project treats as an
invariant. The card is `overflow: hidden` and clips it visually; an absolutely positioned box that
starts outside its clipping ancestor still counts toward the document's scrollable width.
`will-change` was ruled out as the cause by removing it and re-measuring: still +41px.

Measured after the fix, per kind, at 390px: four screenshots of the card 150ms apart hash to
**4 distinct frames** under `no-preference` and **1** under `reduce`, with the card box unchanged
at 358×148 and no horizontal overflow in either.

### A panel with its own background was wearing the sky's text colours

Found while screenshotting the above, in light theme, which is not the theme this app is usually
read in.

`.sky .text-ink` cascades to every descendant. The layover panel is `bg-card` — **white** in
light theme — so its text was being painted in the near-white on-sky ink. The free-time figure
(`23h 59m`, the largest thing in the panel) measured **1.19:1**, against 16.86:1 on the same card
with no sky.

Dark theme never showed it: there `--color-ink` and `--color-ink-on-sky` are the same colour, so
it reads 13.65:1 either way. That is why it survived from the day skies shipped.

Fixed by scoping the overrides out of any descendant that brought its own background:
`.sky .bg-card .text-ink` and friends. Keyed on `.bg-card`, not on the panel's test id — the rule
is "a surface with its own background gets its own text colours", and the next panel inside a sky
will need it too.

---

## 2026-08-31 (the board goes)

### The DEP/ARR board was deleted — with REPORT gone, it was the timeline twice

Reported as "dep, arr has duplication", and it was right. The board read

    DEP                07:15
    ARR                12:50
                      8h 36m

directly above a timeline reading `07:15 Departs / 8h 36m airborne` and `12:50 Lands`. Removing
REPORT earlier the same day had left a board whose every remaining row was the words underneath
it, four lines apart.

**The one thing it said that the timeline did not: the landing DATE** on a sector that crosses a
local day (`ARR Wed 12 · 16:20`). That moved onto the Lands row — `Lands · Wed 12` — and is
measured **from the day the duty started, not from that leg's own departure**. EK448 leaves Dubai
on the Tuesday and its second sector both leaves Singapore and lands in Auckland on the
Wednesday: leg-relative that is a same-day sector and says nothing, while the fact someone waiting
needs is that she is down on the Wednesday. Getting this wrong is what the first version did, and
the existing red-eye test caught it.

**The elapsed figure survives only on a multi-leg pairing** (`1d 2h total`), where it means the
whole trip including ground time — something no per-leg airborne figure says. On a single sector
it was the airborne figure again, to the minute, which is exactly the duplication being removed.

### "free until report" stays, and it is not an inconsistency

Asked, reasonably: report is off the card, so why does the layover panel still say
`23h 59m free until report`?

Because it is not printing a report time — it is naming what the number is counted TO. Landing to
next report is the figure she plans a layover against, and it is the one thing a generic travel
assistant cannot know; `MIN_LAYOVER_FREE_HOURS` and the whole transit-vs-layover split are built
on it. Drop the word and `23h 59m free` no longer says free until when, which is the only reason
the number is worth printing.

`formatLayoverBrief`'s `REPORT` line stays for the same reason: that text is read by a model, not
by her, and it is the roster context the assistant is being handed.

---

## 2026-08-31 (calendar taps during the month slide)

### The e2e suite was not flaky. A click during the month slide is genuinely lost.

`crew.spec` failed on three CI runs in one afternoon and blocked two deploys, always at
`openAddForm` waiting for the add form. Every time, a re-run went green. The tempting reading —
"workerd dies, it is environmental" — is the one `docs/` already warns against, and it was wrong
again.

**The trace named it, exactly as the runbook says it would.** From the failing run's
`playwright-report` artifact:

    3.1s  isVisible  calendar-day-2026-09-10     <- false, August is showing
    3.1s  click      calendar-next
    3.1s  isVisible  calendar-day-2026-09-10     <- true
    3.1s  click      calendar-day-2026-09-10     <- "click action done"
    3.3s  waitFor    flightno-input              <- never appears

and the DOM snapshot taken after that click still reads `aria-pressed="false"` on the cell. The
click was performed and the day was not selected. The whole sequence took 200ms; nothing was slow.

**Reproduced deterministically, with a control.** Same build, same machine, one variable:

    press on the cell's own bounding box, mid-slide  ->  selected 0 / 10
    press 600ms later, after it settles              ->  selected 10 / 10

Event listeners say why: mid-slide the press lands on `<html>`. Not the cell, not the grid — the
document. `boundingBox()` reports where the cell was, the 480ms `--ease-snap` transform keeps
moving it, and the ancestor's `overflow:hidden` means the reported point is over nothing at all.

**Playwright's actionability check does not catch this**, which is what made it look like flake.
It logged "element is visible, enabled and stable" and clicked anyway: the tail of the ease-snap
curve moves sub-pixel amounts per frame, which samples as stable while the cell is still
travelling.

**Fix: `pickCalendarDay` waits out the slide** (`waitForMonthSettled` in `e2e/helpers.ts`, keyed
on the new `calendar-track` test id, via `getAnimations().finished`). Verified by the same
control, with the wait swapped in: 10 / 10.

**Deliberately NOT changed: the app.** A tap during the slide does nothing, and that is defensible
— it is what a native calendar does, the window is 480ms, and it was measured NOT to select the
wrong day. Two frames of `requestAnimationFrame` come first in the wait so a transition committed
in the same tick is registered before the list is read; under reduced motion the transition is
switched off and the empty list is a legitimate "already settled".

**The method note worth keeping.** Three failures with three different shapes read as noise, and
"the retry passes" is not evidence about the cause. The evidence already existed: `trace:
"retain-on-failure"` is on and CI uploads `playwright-report`, so

    gh run download <run-id> --name playwright-report --dir .
    unzip test-results/<spec>/trace.zip

was one command away the whole time, and named the cause in one read.

---

## 2026-08-31 (card cleanup)

### Report time is off the card entirely, and "Leave home" with it

The board read `REPORT / DEP / ARR`, and the timeline four lines below it read
`Leave home / Report / Departs / Lands`. On a single-sector duty three of the board's rows were
the same three times, in the same zone, twice on one card. Asked what the REPORT column was for,
there was no answer that survived pointing at the timeline underneath it.

It came off the board first, and then off the card altogether, on the user's call. **His reason
is the only piece of real user evidence this repo has ever had on the question: a crew member
carries her airline's own app, which gives her report time and e-gate.** This card was restating
a number she reads somewhere more authoritative.

That reverses "the report time is the single value this app exists to show", which appears above
in this file and was quoted back at him as if it settled the matter. It did not: it is a note an
earlier session wrote, never checked against a user. **Citing this file as evidence for what a
user needs is circular. It records what was decided, not what was true.**

What remains: `flights.report_utc` is stored, drives the push alert, and sets the layover panel's
"free until report" — which stays, because it answers a different question (how much of the rest
is hers). `TripLegsPanel` lost its per-leg `Report` line too; leaving one behind a pencil would
have been the inconsistency that generates the next question.

The origin's station line moved from the deleted report row onto the first `Departs` row, so the
card still names the city she leaves from rather than only its IATA code in the headline.

**`Leave home` was deleted.** It was `report − 55 minutes`, flat. No home address, no distance, no
traffic, no setting — a subtraction she can do in her head faster than she can open the app.

**The consequence to watch: the crew/family view lost it too.** `e2e/crew.spec.ts` used to assert
that the person reading a SHARED roster can see the report time, with the comment "the whole
point of sharing: the person who is NOT crew can see the clock". That person does not have the
airline app the removal is justified by. The assertion now checks DEP and ARR instead. If report
should survive on the shared card, it needs a read-only branch, and that assertion goes back.

`.sky .text-report` and `--color-report` stay in `tokens.css`, unused. This is a fresh product
call that may be reversed, and restoring the token would mean re-running the contrast check.

### The layover panel reaches the day the flight home lands

`restForDay` matched `landing day ≤ day ≤ next DEPARTURE day`. EK192 leaves Lisbon at 14:20 on the
1st and touches Dubai at 01:30 on the 2nd, and **both days render the same trip card** — so one of
the two carried the Lisbon panel and the other did not, with nothing on screen to explain the
difference. The window now ends at the outbound's LANDING (`nextArrUtc`), so the panel lives on
every day of the duty the layover feeds.

### Only one device in production had ever been subscribed to push

Reported as "I never got the notification for today's flight". Measured against production D1 on
2026-08-31:

    SELECT COUNT(*) FROM push_subscriptions;   ->  1

One row, an Apple endpoint, registered 2026-08-10, belonging to the account that raised the
report. **The crew member's own account had zero.** Meanwhile eight of her flights carried a
`report_notified_at`, stamped 110-119 minutes before report — the 120-minute default lead inside a
15-minute cron, so the scan's timing was never the problem.

Three defects, none of which could be seen from the database alone:

1. **The claim was a receipt.** `claimFlightForNotification` stamped `report_notified_at` and only
   then looked up subscriptions and sent. A user with no device got every alert recorded as
   delivered, and because the candidate query filters on that column, registering a phone
   afterwards could never recover one. The subscription lookup now happens BEFORE the claim, and
   a candidate with no device is left unclaimed (`skippedNoSubscription`).
2. **A failed send burned the flight.** 404/410 deletes the dead subscription, but a 500 or a
   network error left the stamp in place with nothing sent and no retry, ever. The claim is now
   put back (`releasedAfterSendFailure`), and `runArrivalScan` restores both `arrival_alert_stage`
   and `arrival_notified_at` rather than leaving a timestamp for a notification nobody got.
3. **Failure left no trace at all.** `sendPush` returned `{ ok: false, status }` and every caller
   discarded it — nothing in D1, nothing in the logs, so "the push service rejected it" and "the
   alert never arrived" were indistinguishable. One `console.warn` in `sendPush` now records
   status and endpoint HOST. Host only: the endpoint's path segment is the subscription's bearer
   credential.

**A stamp in `report_notified_at` still is not proof of delivery** — it proves a send returned 2xx,
which is the push service accepting the message, not a phone showing it. The only end-to-end check
is `/api/push/test` from the device.

That check was then run, from the phone that owns the one subscription:

    {"sent":0,"subscriptions":1,"expiredRemoved":0,"failedWithStatus":[400]}

**So there is a fourth cause, and it is upstream of all three above: Apple is rejecting the send
outright.** Not 404/410 — the subscription is alive; the request is being refused. Combined with
the subscription count, the honest reading is that **no push from this app has been delivered to
anyone**, and every `report_notified_at` in the table records a send that a push service accepted
or refused, never a notification a person saw.

`400` does not name a cause. Apple returns it for a malformed VAPID JWT, a `k=` it will not
accept, and a body it will not accept. **The response body says which, and `sendPush` was
throwing it away** — so the next step is not a guess at the JWT, it is reading what Apple
actually said. `SendPushResult` gains `detail`, `/api/push/test` returns `failed: [{status,
detail}]`, and the `console.warn` carries it.

What is NOT established: whether this ever worked. The subscription was registered 2026-08-10,
nothing logged failures before today, and the 400 is a measurement from 2026-08-31 only.

Do not "fix" the JWT from a symptom. Read the body first.

### `VapidPkHashMismatch` — the key was replaced, and every subscription died with it

Reading the body took one deploy and one tap:

    {"status":400,"detail":"{\"reason\":\"VapidPkHashMismatch\"}"}

**A push subscription is bound, permanently, to the VAPID public key that created it.** Replace
the pair and the push service refuses every send to every subscription taken out under the old
one. Apple says so with a **400**, not the 404/410 that means "gone", so nothing in the expiry
path caught it and the row sat there being retried against a service that would never accept it.

This was not a mismatch between two code paths: `/api/push/config` serves `env.VAPID_PUBLIC_KEY`
and `sendPush` signs `k=` with the same variable. The mismatch is against the past — the
subscription was registered 2026-08-10 under a key that is no longer the one in the environment.
**When that replacement happened is NOT established.** `wrangler versions list` only reaches back
to 2026-08-30 and secrets carry no dates.

Two fixes, because the dead end had two halves:

1. **Server.** `sendPush` marks a `VapidPkHashMismatch` body as `expired`, so the caller drops the
   row. The subscription is not gone, but it can never work again, and for the caller that is the
   same instruction. Matched on the body, narrowly, and NOT on bare 403/400: this branch deletes
   rows, so a bad `VAPID_PUBLIC_KEY` of our own would sign every user out of notifications at
   once. Recoverable, but it gets its own log line rather than happening quietly.
2. **Client.** `handleToggleOn` now tears down whatever subscription the browser is still holding
   before taking a new one. `pushManager.subscribe()` with a different `applicationServerKey`
   does not re-key an existing subscription — it throws `InvalidStateError`, which this screen
   turns into "Couldn't enable notifications — try again", forever. Unconditional teardown rather
   than comparing keys: it only runs on an explicit tap, and `applicationServerKey` comes back as
   an ArrayBuffer that would have to be re-encoded to compare against the served string.

**Operational rule, now in RUNBOOK.md: regenerating the VAPID pair means every user re-enables
notifications.** There is no server-side migration; the old key is what the push service hashed.

The lesson is the same one the three defects above taught, one layer up: a status code is not a
cause, and the system had been discarding the one string that named it.

Not fixed here, because it is not a code problem: the crew member's phone has never granted
notification permission. Nothing in the Worker can create a subscription she did not accept.

### The timeline stagger could only ever play once

A CSS entry animation fires once per element. A pairing renders the same trip — same `trip.id`,
so the same `DayDetailCard`, so the same rows — on every day it spans, so tapping 1 Sept and then
2 Sept animated nothing at all: React kept the DOM nodes and only the panel below them changed.
`TripSummaryLines` takes a `timelineKey`, and the day card passes `isoDate`, which remounts the
rows per day. No animation library: the fix is one prop, and `motion` would have been ~30kB to
replace a class that already works.

**Testing this needed care, and the first version of the test was wrong.** Counting
`animationstart` events straight after switching days passed with the fix reverted — rows enter at
`70ms * index`, so a listener installed while the FIRST day's timeline was still settling caught
its trailing rows and counted them as the second day's. `e2e/duty-card-report.spec.ts` now waits
for every `.tl-enter` animation to reach `playState === "finished"` before it starts counting.
With that wait in place, reverting the fix gives 0 starts.

---

## 2026-08-31 (later)

### The morning she lands is a day on the calendar, and it is called an arrival

Yesterday's fix ended a base-bound span at the BOARDING, to keep the landing morning off the
away band. That corrected the wrong thing. The complaint was never that the day was marked — it
was that `dutyDayMarks` labelled it `layover · DXB`, an outstation day at her own base. Dropping
the day meant the calendar said nothing at all about the morning she walks in, which is the one
thing the person waiting is looking for. Measured on the real corrected EK248: marked days ran
`22 23 24 25 26` and the 27th, when she actually got home at 00:30, was not on the grid.

So: the span runs to the landing again, and the label is fixed at source. `DayKind` gains
`arrives` — the day she lands at base without having departed on it. `return` still means the day
the duty is FLOWN. A red-eye home owns both, and they are different facts: `26 ↙GIG` (flying
home) then `27 ↙DXB` (lands 00:30).

**Rejected — leave it to the card.** `ARR Thu 27 · 00:30` is already on the trip card, and that is
where an exact time belongs. But the calendar is the surface someone opens to ask "when is she
back", and a month grid that has no cell for the answer sends them to tap through days.

### The calendar keyed itself to an outstation when no leg departed base

`homeTz` took the earliest leg departing `HOME_BASE_IATA`, falling back to
`trips[0].flights[0].depTz`. A roster can genuinely contain no departure from base: she joined a
routing down-route and her only sector is the one home. The fallback then keyed the whole grid to
whatever the API listed first — for a GRU→DXB sector, São Paulo. Measured, same span, two zones:

    Asia/Dubai        -> 2027-02-10  2027-02-11
    America/Sao_Paulo -> 2027-02-10

Every day boundary on the grid was an outstation's, and the morning she got home was not a day at
all. A leg that LANDS at base now comes second in the chain: its `arrTz` is the same airport's
zone read from the other end, already in the data, no lookup needed.

This surfaced as `board-partway.spec.ts` failing against correct code and correct data — worth
recording, because the natural reading of that failure was "the arrival change is broken".

---

## 2026-08-31

### The grid marks the neighbours' days it happens to draw

A month grid carries its neighbours' edge days — the first week of September is drawn inside
August's grid. `tripDaysInMonth` was called for the rendered month only, so those cells were
blank whatever was on them: EK192 lands at base on 1 Sep and August's grid showed the away band
stop dead at the 31st, on the one screen the person waiting at home was looking at.

`buildMonth` now marks the month before and after as well and merges, current month last. The
band's joining logic already read `dayMarks` and never `inMonth`, so a run that crosses the month
edge became one object for free. The optimistic-date loop is scoped to the dates the grid
actually draws rather than to the month, for the same reason.

Cost is two extra `tripDaysInMonth` calls per panel, six per render. They walk a handful of spans
into a small Map; not worth memoising.

### A day inside a journey asks before it opens the add form

A layover day has no leg *departing* on it, so `tripsForDay` returns nothing and it falls into
the empty-day branch — which mounted `AddTripForm`, and the form autofocuses its flight-number
input. Tapping the middle day of a Buenos Aires layover therefore threw the phone keyboard up
over the city guide she had come to read, and scrolled the page 224px doing it.

Measured before changing anything: a day with a departure (22 Aug `↗GIG`, 27 Aug `↙EZE`) already
behaved — focus stays on the day button and a `+ Add another duty` button asks first. Only the
in-band layover days were wrong.

They now get the same treatment: `+ Add a duty` first, form on request. Asking for it still
focuses the input — the keyboard is right when it was asked for and wrong when it was not. The
empty-day card is keyed on `isoDate` so "I asked on THIS day" does not follow her to the next.

The card's own date line said "— no duty" directly above a panel headed "Layover · Buenos Aires",
which is the same misreading in words that the open form was making in behaviour. On a layover
day it now reads "— no duty, down-route in Buenos Aires", resolving the city through `useAirport`
exactly as `StationLine` does and falling back to the bare IATA until it lands. Every existing
assertion matches `/no duty/i` and still passes.

While here: `Trip · {totalDays} days` on the in-progress card was unconditional, so a turnaround
read "Trip · 1 days". Pluralised. It has been wrong for as long as the card has existed and was
only ever visible on a one-day trip that is happening right now.

### The add form shows the date each leg resolves to

The preview listed times only (`Dep 22:25 / Arr 01:10⁺¹`), so a multi-leg flight walking the date
forward was invisible until after saving — which is exactly how a pairing landed a day late. Each
leg row now carries its departure date, right-aligned on the route line, and its arrival date next
to the arrival time when that falls on a different day.

The `⁺N` superscript is gone: it fired on the same condition and said less. It matters more now
that choosing a boarding point re-dates the whole routing — that movement was previously
invisible, and is now the point of the row.

Measured at 390px on the widest case (two legs, a day offset on each): card 322/322, page 390/390,
smallest control font 16px.

---

## 2026-08-30 (latest)

### A day that has already passed can be filled in

Every past day with no duty on it was `disabled`, and `handleDayClick` refused any `iso < today`.
That is date-picker convention — you pick a *future* flight — and a roster is not a date picker.
A duty is usually typed up after it is flown, so the day it belongs to is behind you by then.

Nothing downstream ever objected, checked before changing it rather than assumed:

- `GET /api/schedule/lookup` reads the weekday and validity window of the date given
  (`worker/src/schedule.ts:323-329`); it never reads which side of today it falls on.
- `POST /api/trips` stores whatever `depUtc` it is handed — `LegInputSchema` has
  `depUtc: z.string().datetime()` and no bound.
- Both alert scans search strictly forward: `gte(reportUtc, nowIso)` and
  `gte(arrUtc, windowStartIso)` (`worker/src/report-scan.ts`). A past duty never matches them,
  so recording one cannot fire a push about a flight that has already landed.

What the rule *did* do was strand a correction. A pairing entered with the wrong dates was
deleted, and then could not be entered again — the only way back was to wait for the date to
become the future, which it never does.

Past days stay dimmed at `opacity-60`. Behind you is still worth seeing; it is just no longer
unreachable.

Two things went with it, both orphaned by the change rather than tidied opportunistically:
`tripByDay` (built per month, read only by the gate) and `handleDayClick` itself, now that the
tap is `onPickDay`. The `mode="picker"` prop is left in place but **nothing passes it** — the
inline add form replaced the stepper it was built for.

---

## 2026-08-30 (later)

### The picked date is the sector she flies, not the one the aircraft started on

`legDatesFromPicked` read the picked date as leg 0's departure at the flight number's origin.
That is only her duty date when she works the whole routing. EK248 is EZE→GIG→DXB; Isis worked
it from Rio and her roster said "26 Aug", meaning the **Rio** departure. Anchored on leg 0 the
app put Rio on the 27th and Dubai on the 28th — a day late, for a crew member who was home at
00:50 on the 27th.

The function now takes an `anchorIndex` and slides the whole routing so that leg sits on the
picked date; legs before it date backwards. The gaps between legs stay exactly as the schedule
fixes them — only which calendar day the run starts on is the picker's to decide.

`Where do you get on?` in the add form is the mirror of the `Where do you get off?` panel that
already existed, and the pair now covers the whole question: a multi-sector flight number is one
aircraft routing, and the crew can join it and leave it anywhere along the way. The legs outside
her duty are still saved with `operating: false` — `/api/trips` partitions on that flag and never
puts them in `flights`, so the split works at either end for free.

`TripLegsPanel` splits the two sides, because they are different facts: **"Aircraft arrives
before you board"** above her duty, **"Aircraft continues without you"** below it. One heading
for both would have been wrong half the time.

**Not done:** the leg rows in the add preview still show times without dates. Showing the
resolved date per leg would have let this be caught before saving rather than a week later. It is
the cheaper half of the fix and it is still worth doing.

### Motion was too subtle to read as motion

All three entrances were tuned so far down that they read as flicker. `--duration-enter` 240ms →
420ms, `fade-rise` travel 8px → 20px, the calendar's month settle 320ms → 480ms.

The duty timeline animated only its **first three rows** — the numbered `.tl-enter-1/2/3` classes
could not scale past what someone had written by hand. Every row now carries one `.tl-enter` and
an inline `animationDelay` of `70ms * index`, clamped at 400ms so a long timeline still settles
promptly.

The reduced-motion structure is unchanged and load-bearing: `opacity: 0` and `animation-name`
both live inside `@media (prefers-reduced-motion: no-preference)`, so under `reduce` the row gets
neither. An inline `animation-delay` with no `animation-name` is inert, so the row simply renders
present — never hidden, never mid-fade.

---

## 2026-08-30

### A finished alert stage stopped being a reason to skip an arrival refresh

`GET /api/ingest/upcoming-arrivals` used to hide any flight whose `arrival_alert_stage` was `0`,
on the reasoning that a flight which has announced its landing needs no more corrections. That
reasoning holds only if the stored arrival is right — and it is the stored arrival the refresher
exists to fix.

EK248 on 2026-08-27 shows the loop. fr24's estimate walked `23:58 → 00:03 → 00:05 → 00:09`; the
refresher wrote 00:09; the Worker's scan then claimed stage 0 against that stored time and
pushed **"landing now"**. From the next run on, the log reads `nothing arriving in the next 4h`
for a flight that was still in the air. It landed at 00:50. Forty-one minutes of drift that
nothing could write, and a family told to leave for the airport early.

Two changes, both in `worker/src/ingest.ts`:

- **The time window is the only filter now.** A flight that really has landed leaves the window
  on its own 20 minutes later, so keeping it costs one fr24 lookup, once.
- **A correction re-arms the alerts only when the corrected arrival is still ahead of now.**
  Removing the stage filter opened a path where fr24 reporting an already-past landing would
  clear the stage and fire "landing now" at someone whose crew is already in the car. A
  correction into the past is news, not an announcement.

The 10-minute `isMaterialDrift` threshold is unchanged. It suppressed the last write before the
freeze (00:09 → 00:16 is 7 minutes), but with the row staying visible the drift keeps
accumulating until it crosses the threshold on its own. Lowering it would buy noise.

---

## 2026-08-23 (later)

### The calendar and the day card were keyed in different time zones

Reported as "the 19th shows a layover at JED". The 19th's own card said **DXB → JED, EK805,
departs 06:55** — a day with a departure cannot be a day spent down-route, so the grid and the
card were contradicting each other on the same screen.

They were, literally. Two different `homeTz` values reached the same render:

- the grid took `nextDuty.depTz`
- every day card took `trips[0].flights[0].depTz`

Mid-pairing those are not the same zone. With the next duty leaving Buenos Aires (UTC−3),
EK805's 06:55 Dubai departure is `02:55Z`, which is **23:55 the previous day** in Buenos Aires.
The grid filed the departure under the 18th; the 19th then held no departure at all and fell
through to the layover fallback, which labels the day with the last station landed at.

Reproduced against the real marking code before anything was changed:

```
home base tz (Asia/Dubai)     -> 18: (none)       | 19: outbound JED
nextDuty.depTz (Buenos Aires) -> 18: outbound JED | 19: layover JED
```

The second line is the screenshot.

**One zone now, and it is the crew's BASE** — taken from the earliest leg departing
`HOME_BASE_IATA`, because that leg's `depTz` is the base airport's own zone. `trips[0]` is not a
safe stand-in either: the API's order is not chronological and its first leg can depart an
outstation, so the day cards were only accidentally right.

**The first regression test for this was a tautology**, and the mutation caught it. It rendered
at the module-level `now` (10 August), where the next duty IS the JED leg and the two zones
coincide — restoring the bug changed nothing and the test still passed. It now renders at a
`now` that sits mid-pairing, which is the only state where the two zones differ.

---

## 2026-08-23

### Transit is not a layover, and the preview card stops hiding the detail

Four things on the day card, from one screenshot.

**A two-hour stop is transit.** EK247 sits at Rio for about two hours on the way to Buenos
Aires, and the card offered "Layover · Rio de Janeiro — 5m free until report" with a city guide
for a city she never leaves the airport of. `MIN_LAYOVER_FREE_HOURS = 6` now gates the rest
panel, and the timeline says "Transit · GIG" rather than "Layover · GIG".

Six hours is a product judgement, not a regulation: it is roughly where leaving is worth the
trip in and out. It is one exported constant precisely so it can be argued with.

**A turnaround is named.** Out of base and back the same local day now says so on the card. It
otherwise read as an ordinary duty with an odd route chain, and the ground time in the middle
was the same word as a three-day stay in Buenos Aires.

**The rest panel moved inside the flight card.** It was a second card stacked below, so one day
read as two things. A day holding two duties passes the rest to the first card only.

**The preview card carries the detail.** Reported as "day 22 renders without details": the home
screen showed a route and three board rows, while the timeline, the weather and the glyph were
all one tap away with nothing on screen saying so. The preview is no longer board-only.

**Rejected: auto-selecting today on load.** It gets the same screen and is the more obvious fix,
but it deletes the unselected state entirely — `next-duty-card` becomes unreachable, and nine
tests that use it as their "the roster rendered" gate have to be rewritten. Enriching the
preview reaches the same place without removing a state the rest of the app still reasons about.

**Weather moves now.** A drawn glyph in the header: falling drops, drifting cloud, turning rays,
a storm flash. `transform` and `opacity` on a handful of small nodes — never the card's field,
which is still static because animating a full-card background repaints every frame. All of it
sits inside `prefers-reduced-motion: no-preference`, so reduced motion keeps the icon and drops
the movement rather than hiding it.

Drawn rather than emoji: emoji render differently per platform, cannot take a colour token, and
this one has to sit on a dark sky in both themes.

**Still open: the Jeddah case.** The 18th shows outbound and the 19th shows a layover at JED for
a duty that is a turnaround. Reproducing the reported shape from the marking code did not
produce it — `awaySpans` closes an unclosed span at the last landing, which is the 18th — so the
roster holds something the repro does not. Not guessed at; needs the actual legs.

---

## 2026-08-22

### The flight card wears the destination's sky, and contrast decided the shape of it

Weather as a row of data was the wrong reading of it. On a card that already carries a route, a
flight number and three times, one more row is one more thing to parse. The card's own surface
was doing nothing.

Four directions were drawn and B — the whole card becomes the sky — was chosen.

**Contrast decided everything else, and it was measured before a line of it was built.**
`lib/contrast.ts` is WCAG 2.1 relative luminance; `lib/contrast.test.ts` reads the gradient
stops out of `tokens.css` itself and asserts every text token against the LIGHTEST stop of every
sky. Reading the real file is the point — a copy of the values would keep passing after someone
lightened a gradient, which is exactly the change that breaks this.

What that measurement found, none of it visible by eye:

| on a sky | dark theme | light theme |
|---|---|---|
| `--color-ink` | 10.3–11.1 ✓ | 13–14 ✓ |
| `--color-ink-muted` | **3.97–4.28 ✗** | **3.89–4.22 ✗** |
| `--color-report` | 8.8–9.5 ✓ | **3.54–3.84 ✗** |

Two consequences.

**The sky is dark in both themes** — the same licence the departure-board panel already takes.
Not a style choice: in light mode `--color-report` red-shifts to the accent blue, which lands at
3.54:1 on a sky. The report time is the single value this app exists to show, and a light sky
would mean dimming it.

**Three on-sky text tokens exist** because the ordinary ones do not survive the move.
`--color-ink-muted` misses the floor by half a point on every field. The test carries an
inverted assertion for this — if the ordinary muted token ever passes, the skies have been
darkened enough to drop the extra tokens, which is a simplification rather than a failure.

**Text is themed by scoping, not by threading a prop.** `.sky .text-report { … }` beats the
utility class through the subtree; the alternative was an "on sky?" boolean through every
element of the card. The e2e proves the override actually wins in a real engine — removing it
repaints the report time `rgb(47, 111, 237)`, the exact blue measured at 3.54:1.

**Five fields, not eleven.** Grouped from WMO 4677 by what changes what she packs: rain vs storm
vs snow, not "moderate" vs "dense drizzle".

**Falling weather is static.** Raking hairlines for rain and storm, a dot field for snow, both as
CSS gradients. Animating them would repaint the whole card every frame, which the layout rules
here forbid.

**No forecast, plain card** — which is most of the roster, since forecasts reach about 16 days.
The alternative considered and rejected: a seasonal average behind the card. It would look
exactly like a real forecast, which is the failure that shelved weather here in the first place.

**Known cost, not yet solved.** A list mixing skied and plain cards can read as though the plain
ones failed to load. Worth watching once it is in use.

---

## 2026-08-21 (last)

### The other three wants get pointers, not tables

Four things were asked for on a layover: transport cost per km, attractions, weather, what's on.
Weather shipped. This entry is why the other three did not become data in this app.

**The test that decided it.** The copy button was pointed at a real Bangkok layover and the
resulting answer graded question by question. Transport and attractions came back genuinely
useful — rates, which app is standard, and three things that fit the hours, correctly picking a
Saturday-only market because the brief said which day she is free. Weather came back as a
*seasonal average*, which is what a model has instead of a forecast. What's on came back as "I
don't know", correctly.

So the gap was weather, and only weather. Building the other two would duplicate an answer that
is already good, at the cost of a licence, a coverage gap and a table that rots.

**Attractions: rejected as data, shipped as a link.** Wikivoyage's API is free, key-less and
CORS-open, and its "See"/"Do" sections parse. It was still turned down: a static listing cannot
know she has 30 hours and that one of them is a Saturday, so it is strictly worse than what the
brief already elicits. A search link to the city guide costs one line and never goes stale.

**What's on: rejected as data, shipped as a link.** No source covers this network. Ticketmaster
is the best of them and reaches about 25 markets, thinning out across exactly the Middle East,
South Asia and South-East Asia that EK flies to most. A tile blank for most destinations is worse
than no tile.

**Transport: left to the brief.** There is no licensed per-km source (Numbeo prohibits automated
collection and starts at $260/mo) and Uber publishes no per-km rate at all. Seeding 108 rates
from memory was considered and rejected outright — plausible, unsourced, partly wrong figures
with no `checked_at` is the fabricated-tile failure wearing a different hat. The brief asks the
question; the assistant answers it well.

**Sunset shipped, because it was already paid for.** The forecast call returns it. DECISIONS
wanted "weather and sunset" from the start, and on a layover the useful half is how much daylight
is left, so it sits on each forecast row rather than getting a tile.

---

## 2026-08-21 (later)

### The forecast is real or it is absent

Weather sat under "Not built, deliberately" since 2026-08-18, blocked on two things: an airport
`lat`/`lng` column and a weather API. Both are now settled.

**Coordinates** come from OurAirports (public domain), matched on `iata_code`; all 108 seeded
codes resolved. They ship in migration `0015` for rows that already exist and in
`scripts/seed-airports.sql` for a fresh database — the migration alone is not enough, because a
new local DB has no airport rows at the point migrations run, so its `UPDATE`s would hit nothing.

`lat`/`lng` are **nullable and stay nullable**. A station that self-warms in from a live provider
arrives without them, and NULL has to mean "no forecast here" rather than a guessed point.

**Open-Meteo** is free, needs no key, and its terms name "private or non-profit websites or apps
that do not have subscriptions or advertising" as qualifying non-commercial use. Limits are
10,000 calls/day and 300,000/month against two or three users. CC BY 4.0, so the credit is on the
card itself.

**The constraint that shaped the feature: forecasts reach about 16 days.** A roster is commonly
published a month out, so *most* layovers have no forecast, and the API says so explicitly:

```
Parameter 'start_date' is out of allowed range from 2026-05-20 to 2026-09-05
```

That is the normal case, not an error. The card renders "No forecast yet — usually available
about two weeks ahead" and draws nothing else. **A seasonal average was rejected outright**: it
looks exactly like a forecast, and "two fabricated tiles are worse than none" is the reason this
feature was shelved in the first place. An assistant already supplies climate averages — the only
thing worth adding is the part it cannot know.

**Only an answer is cached.** A refusal, a network failure and an out-of-range date are not
evidence that no forecast exists; the same station has one a week later. Caching them would blank
the card for the rest of the session.

**A missing precipitation figure renders "—", never 0%.** Writing 0% would be a claim about rain
we did not receive. The same reasoning skips a day with no temperature rather than defaulting it.

**Client-side, not through the Worker.** The schedule providers live server-side because they
need secrets and a real browser; Open-Meteo needs neither, and a session cache in
`web/src/lib/weather.ts` mirrors what `lib/airports.ts` already does for airport lookups. A
Worker route and a D1 cache table would be more moving parts for three users.

Two tests were written badly first and mutation caught both: the `body.error` guard passed with
the check deleted, because the stubbed refusal carried no `daily` either — it now has a case that
sets both. And a `=== undefined` guard let a JSON `null` through as a real reading, which is what
the API actually sends for a value it has no answer for.

---

## 2026-08-21

### The layover brief is a clipboard button, not four integrations

A layover card wanting weather, attractions, local transport cost and what's on looks like four
API integrations. Each was priced and read at source before any of it was built, and only one
survived:

| Want | Source | Verdict |
|---|---|---|
| Weather | Open-Meteo | Usable — but free tier is **non-commercial only**, CC BY 4.0 attribution, and it still needs the `lat`/`lng` seed column this repo has never had |
| Attractions | OpenTripMap / Wikivoyage | Workable; source not chosen |
| What's on | Ticketmaster Discovery | ~25 markets, effectively US/CA/AU/UK/EU. The gap lines up almost exactly with the Middle East, South Asia and South-East Asia this roster flies to most |
| Taxi per km | Numbeo | Has the exact figure (`Taxi 1 km (Standard Tariff)`), no free tier, **$260/mo**, and automated collection is prohibited by its terms |
| Taxi per km | Uber API | Approval-gated; needs pickup AND destination; the `TAXI` product returns `low/high_estimate: null`; and ToS § II B forbids showing its prices beside a competitor's — which is exactly a taxi/Uber/Grab row |
| Taxi per km | TaxiFareFinder | Municipal rates, good data — but needs origin AND destination, and the key is a contact form |

**The real blocker on the transport half was never price.** Every route-priced source needs two
coordinates. Crew ride a company shuttle from the airport to a hotel this app does not know and
has no field for, so there is no route to price. That is also why a *rate* per km is the right
unit and an airport-to-city fare is the wrong question.

And **Uber publishes no per-km rate at all** — "the base rate is determined by the time and
distance of a trip", quoted from its own price-estimate page. It is not a sourcing problem; the
number does not exist.

**So the app packs context and stays out of answering.** `formatLayoverBrief` builds a prompt
from what the roster already knows and copies it; the assistant she already uses answers all four
questions, anywhere, at no cost and with nothing to go stale. Nothing is asserted that the app
does not know, so — unlike the weather tiles prototyped and dropped on 2026-08-18 — there is no
tile that can be wrong.

**Free time is measured to REPORT, not to departure.** This is the one line no generic prompt can
produce, and the whole reason the button beats typing the question by hand. `layoverRests` walks
every leg base-to-base rather than within a trip, because a real down-route rest sits *between*
two trips of a pairing — same reason `awaySpans` exists.

**Rejected: asking for the hotel.** It is an optional field on the panel, never stored and never
required. Making it mandatory would buy sharper answers at the cost of typing a hotel name on
every layover, and the prompt is useful without it.

**Rejected: a per-device prompt language.** The prompt is read by a model, not by her, and every
assistant replies in whatever language she follows up in. A setting would be a setting for nothing.

Guards all carry a test proven failing-first by mutation: removing the at-base skip, the
station-match guard, the report-after-landing guard, or swapping report for departure each fails
exactly one test. The e2e asserts the panel on the day in the MIDDLE of a layover — no duty at
all, the branch that renders "no duty" and nothing else — plus the 16px control floor and no
horizontal overflow at 390px.

---

## 2026-08-19 (later)

### Deleting an account deletes one row

`user.deleteUser.enabled` in better-auth, so `POST /api/auth/delete-user` removes the `user` row.
Everything else goes with it: session, account, trips, flights, crew invites in *both*
directions, push subscriptions, notification prefs — every one of those tables declares
`ON DELETE cascade`.

The cascade is **measured**, in `worker/test/delete-account.test.ts`, through the real API rather
than with hand-written rows. A declared cascade that the database ignores orphans the rows
instead of removing them and looks identical from the caller's side, so "the schema says
cascade" is not evidence. The test counts before as well as after, because all-zeroes proves
nothing unless the counter was shown able to be non-zero.

**Rejected — soft delete.** If the data stays, "delete" is a lie, and this app holds one person's
whole movements.

**Rejected — an emailed confirmation link.** Stronger, and it would sidestep the freshness limit
below, but it needs a new template, a callback route and a landing state for two users. The typed
address plus a recent session is enough friction here.

**The confirmation is typing your own address** into a native `<dialog>`, compared trimmed and
case-insensitively — it is a fact on screen being confirmed, not a password, and failing someone
over a capital letter only teaches them to paste it.

**Two things this inherits from better-auth, both deliberate:**

- **Session freshness.** With no password to ask for (email OTP and Google only), the endpoint
  refuses a session older than 24h. That is an answer, not a fault, so it gets its own error type
  and its own message — a generic "something went wrong" at the moment someone is deleting their
  data is the worst possible response.
- **An Origin check.** `/api/auth/delete-user` is CSRF-protected in a way the app's own Hono
  routes are not; without the header it answers `MISSING_OR_NULL_ORIGIN`. Browsers send it
  automatically, so it costs the client nothing, but tests must supply it — and the trusted value
  comes from `BETTER_AUTH_URL`, not from the URL under test.

**Known consequence:** when one half of a paired crew deletes their account, the invite row
cascades away and the other side simply stops seeing them, with no notification. Accepted for an
app with two users.

---

## 2026-08-19

### A deploy is not done until production says so

`wrangler deploy` exiting zero, and the deploy job going green, are the same evidence: the CLI
was happy. Neither is evidence that the new code answers requests. After #53 merged, this job
was green while production still queried a table the migration had dropped, and nothing caught
it — it was found by hand.

`/api/health` now reports `version`, the commit the Worker was deployed from, injected with
`wrangler deploy --var BUILD_SHA:$GITHUB_SHA`. The deploy job then polls production until it
sees **both** that commit and the asset filename this run built, and fails if it never does.

Two halves, because they fail separately. A worker-only change leaves the bundle hash untouched,
so the asset check alone would pass on a Worker that never updated; a web-only change leaves the
Worker identical, so the version check alone would pass on stale assets.

Retried for five minutes rather than asked once: a request made mid-propagation gets the previous
version and looks exactly like a failed deploy. A one-shot check would have become the flake it
was written to catch.

**Rejected — assert `/api/health` returns `ok`.** It already did, throughout the #53 incident.
Liveness is not identity.

**`pnpm run deploy -- --var …` does not work,** and fails silently. The script is
`build && wrangler deploy`, and pnpm drops `--` arguments rather than appending them to the
chained command, so the var never reaches wrangler and the smoke check could never pass. Worse,
the same call with `--dry-run` appended **deployed for real** — the flag was dropped too. Build
and deploy are separate steps in the workflow for this reason. Calling `wrangler` directly does
honour both flags; this is a pnpm forwarding limit, not a wrangler one.

---

## 2026-08-18

### Days away from base are one band, computed across trips

A pairing is normally two trips — EK247 out on the 22nd, EK248 back on the 28th — and the day
markers were computed *inside* one trip, first departure to last arrival. The layover days
belonged to neither, so the 24th–26th rendered exactly like the 20th and the 21st. For the person
this app is for, that is the wrong answer: she is not flying, but she is also not coming home.

`awaySpans()` (`web/src/lib/dayMarks.ts`) walks the legs base-to-base instead — away opens on a
departure from `HOME_BASE_IATA`, closes on an arrival at it. Two cases a partly-known roster
forces, both tested:

- **A departure from base while a span is still open.** She got home by some route this roster
  does not record, so the open span closes at the last landing seen. Without it, one unclosed
  short trip paints every day up to the next return as away.
- **A span still open at the end of the roster.** It stops at the last landing known. Running it
  to "now" would invent days she may already be home for.

The result is **unioned** with the existing per-trip spans, never substituted for them, so a
roster the walk cannot interpret still marks everything it marked before.

**Amended: a span now closes where she boards the flight home, not where it lands.** Both
sources agree on this, through `calendarSpan()` in the same file. The flight home routinely
lands after midnight at base — EK248's wheels touched Dubai at 00:09 — and ending the span on
the landing marked that whole morning away, then labelled it `· DXB`: a day down-route at her
own home airport. The person waiting read the return arrow on the 27th and the band running
through the 28th as "back on Thursday", when she walked in on Friday morning.

This is the one case where a day that used to be marked is now blank, and it is deliberate. It
does not weaken the union above: the layover days between two trips, which is what that union
exists for, are untouched. Measured in `e2e/red-eye-home.spec.ts` against a real browser, and
the same shape is asserted for the DXB↔BCN turnaround in `e2e/autofill.spec.ts`.

A run of away days is drawn as one band: inner corners square off and the 0.5rem grid gap is
bridged by an absolutely positioned child. The band breaks at the week edge, because it cannot
cross a row, and at the month edge, because the marks are month-scoped.

**Rejected — colour the layover cells and let the eye join them.** Tried in three variants
(same fill, softer fill, a connector bar under each week). All three leave seven boxes that
happen to share a colour. The ask was that the days read as *connected*; only removing the gaps
does that.

**Trap:** an absolutely positioned child lays out against the **padding** box, not the border
box, so `inset-y-0` stopped 1px short at top and bottom and left a hairline seam. Caught by an
e2e assertion on edge coverage, invisible in a screenshot.

### Today is marked on the number, not the cell

Today was `ring-2 ring-accent`; the selected day was `ring-2 ring-accent ring-offset-1`. Same
colour, same shape, one pixel apart — indistinguishable, and a day that was both looked exactly
like a day that was only today.

Today now fills the **number** with a disc in `--color-today`; selection keeps the ring on the
**cell**. Different surfaces, so both can be true at once and still be read.

The colour is new and deliberately not the accent: on this screen blue means *duty*, so a blue
ring on an empty day competes with the roster itself. `--color-report` could not be borrowed —
it is amber in dark but blue in light, which would reintroduce the collision in one theme.

**Rejected — a `TODAY` caption under the number.** On a day that also has a duty it wants the
same line as the station code; one of them has to go, or the cell grows.
**Rejected — the same ring in grey.** Colour alone carries it, which fails for anyone who has
trouble with colour, and the grey disappears entirely under the selected ring.

---

## 2026-08-17

### An invitation explains itself before it asks for anything

`/invite/:token` used to land an unknown visitor on an anonymous email field. They had no idea an
invitation existed, no idea who sent it, and no reason to trust the page.

It is now two stages: who invited you and what you would get, then sign-in. The preview route
returns exactly two strings — the sender's display name and a **masked** address — and no
schedule data at all, so the token cannot leak a roster even in principle.

The blurred calendar on that page is **entirely fabricated**. Blur is decoration; one line of CSS
removes it. Nothing real may sit behind it, and it is labelled as a sample and hidden from screen
readers.

### The preview says whether *this* session is the invited one

Invites match on the exact address, and Google hands over whatever address its account carries.
Signing in with the wrong one used to land people in an app with no invitation and nothing
explaining why.

`GET /api/invite/:token` now returns `matchesYou` when a session exists. The comparison happens on
the server against real addresses; only a boolean leaves. Signed out, the field is absent
entirely.

**Rejected — return the invited address so the client can compare.** That hands a full address to
anyone holding a link.

Google's `callbackURL` is the invite page, not `/`: the round trip is a full navigation, so
returning to the app root loses which invitation the visitor came for.

### One rule names the sender, everywhere

The preview page introduced the sender as `korlogan94`; the email that carried people there said
`korlogan94@gmail.com shared their roster with you`. Two halves of one introduction disagreeing —
and the email half handed a full address to someone who had only been invited.

`senderLabel()` (`worker/src/crew.ts`) now serves both: name, else the local part, else `Someone`.

---

## 2026-08-14

### The family share link is deleted; the invite is the only way to share

`/share/:token` gave anyone holding the URL a read-only view of dates and city names. It was
built for the partner waiting at home, and it failed at the one job that matters: it carried **no
clock times**, so the person collecting her could not tell when to leave for the airport.

Adding times to it was considered first and rejected. The link is a bearer URL with no expiry and
no per-person revoke — whoever it reaches, and whoever they forward it to, gets whatever it shows.
Report and landing times are exactly the data her airline forbids her circulating, so putting them
behind a forwardable URL is the wrong trade. The invite already solves this: it is per-person, it
is revocable, and `GET /crew/:userId/trips` already returns the full roster with every time.

**What went:** `worker/src/share.ts` (all four routes), `share-schema.ts`, `SharedViewer`,
`sharedHero`, `ShareView`, their tests, `e2e/share.spec.ts`, the `SharedView*`/`ShareLink` types,
and the `share_links` table (migration `0013`).

**`ShareView` was not the share page.** It was a container holding `CrewPanel` *and* the
link-management UI, so deleting it naively would have taken the invite UI with it. `CrewPanel` now
mounts directly on that tab. The tab keeps `data-testid="tab-share"` because `e2e/crew.spec.ts`
drives it; renaming the tab belongs with the invite redesign, not here.

**`App` collapsed into `SignedInApp`.** The split existed only so a `/share/:token` load could
return before any auth state or effect ran. With no public route left, the indirection was dead.

**The cost, stated plainly:** until the invite work lands, a partner without an account can see
nothing at all. That is a deliberate regression — a link that shows the wrong things is not better
than no link, and keeping it alive would have meant designing around it.

**Not renamed yet:** `crew_invites` names the sender's job, not the relationship — the recipient
may be a partner or a parent, not crew. Renaming the table, routes and UI is queued with the
invite redesign.

---

## 2026-08-20 (latest)

### The harvester's token moved out of the launchd plists

Both plists carried `INGEST_TOKEN` inline in `EnvironmentVariables`. A plist in
`~/Library/LaunchAgents/` is `0644`, so every process on the machine could read the credential
that writes to production. `~/.config/danyeowa/env` was already `0600` and already held the same
value — the plist copy was redundant as well as exposed.

Both `ProgramArguments` now run through `/bin/sh -c` and source that file:

```sh
. "$HOME/.config/danyeowa/env" && exec /opt/homebrew/opt/node@22/bin/node <script> <args>
```

**Rejected: parsing the env file in `ingest-client.mjs`.** It would have meant a new parser and a
test for a format `sh` already parses, and it would not have removed the plist copy on its own.

**`&&`, not `;`.** With `;` a missing or unreadable env file would let the job continue and hit
production with no token, and the log would read as an auth failure rather than a missing file.

Proven failing-first: the token was removed with nothing sourcing the file, and
`com.danyeowa.refresh-arrivals` exited `1` with
`FAILED: Error: INGEST_TOKEN is not set`. After the change both agents exit `0` —
refresh logged `nothing arriving in the next 4h`, harvest logged
`live roster: 147 airborne, 0 new, 571 known total`. The token string no longer appears in either
plist; the same grep finds it in a pre-change copy, so the search was not blind.

**Rotation followed the same day** — see the next entry. Moving a credential into a `0600` file
stops the next read; it does nothing about a read that already happened.

### Rotating that token needed the Worker deployed first

The plist fix stopped the leak, it did not close it, so the value itself was replaced.

**`wrangler secret put` refuses while a PR preview is the newest upload.**

```
✘ Secret edit failed. You attempted to modify a secret, but the latest version of your Worker
  isn't currently deployed.
```

This has nothing to do with the secret. Every PR's `preview` job uploads a version, and an
uploaded-but-undeployed version is exactly what that check trips on: production was serving
`b851dd03` (10:58:55Z) while the newest upload was `469c2877` (11:01:52Z) — PR #75's own preview.

The error suggests deploying the latest version first. That means hand-deploying a PR build to
production, which is not how anything ships here. Merging the PR is the fix — CI's `wrangler
deploy` makes latest and deployed the same version again, and `secret put` then works.

**Worker first, local file second.** `RUNBOOK.md` already said so, the reverse was done anyway,
and it cost a run: the local `env` was promoted before the Worker had accepted the new value.

```
2026-08-20T12:27:47.411Z FAILED: Error: ingest rejected the token (401)
2026-08-20T12:32:36.224Z nothing arriving in the next 4h
```

Failing closed contained it — one refused run, no bad write, recovered on the next interval. The
expensive part was silent: overwriting the local file destroyed the last copy of the old value,
and with it any way to *demonstrate* that the old token is now refused.

**What is proven, and what is only argued.** `authorised()` in `worker/src/ingest.ts` is an exact
string compare, the deployed secret is the new value, the new value returns `200` on ten
consecutive probes, and a garbage token returns `401`. Any value other than the new one is
therefore refused, the old one included. That conclusion follows from the compare. It is not a
measurement of the old string, which no longer exists to measure.

**Allow a minute for a secret to settle.** Straight after `secret put` the same token returned
`200`, `401`, `200`, `200` across 45 seconds as edges picked up the new version. A single `401`
in that window is propagation, not a failed rotation.

---

## 2026-08-19

### The last things still called `roaster` were outside the repo

The 2026-08-13 entry renamed everything inside the repo and stopped at the working copy's own
directory name, the launchd labels and the config path — all three live on this machine, not in
git, so no PR could carry them. That left `cd roaster-me` as the first thing anyone typed to work
on danyeowa.

**Renamed** (this change): the working copy `~/project/portfolio/roaster-me` → `.../danyeowa`;
`~/.config/roaster-me/env` → `~/.config/danyeowa/env`; the launchd labels
`com.roasterme.{harvest,refresh-arrivals}` → `com.danyeowa.*`, with their logs moving from
`/tmp/roaster-*.log` to `/tmp/danyeowa-*.log`. The plists' `WorkingDirectory` and script paths
were rewritten to the new directory. Both agents were unloaded before the move and bootstrapped
after it; `com.danyeowa.refresh-arrivals` was kickstarted once and logged
`nothing arriving in the next 4h` from the new path.

**`ROASTER_API` is gone**, not aliased. The 08-13 entry kept it as a fallback on the grounds that
it was set in a config file "this repo cannot edit" — that was wrong. The file is on this machine,
and it only ever contained `INGEST_TOKEN`. Nothing set `ROASTER_API`, so the fallback was dead
code protecting a case that did not exist.

**The GitHub repo, the Worker and the D1 database needed nothing** — they were already `danyeowa`.
The old `roaster-me` Worker stays up on purpose as a redirector, per §3 of `ROADMAP.md`.

**Still `roaster`, still deliberately:** `docs/superpowers/{plans,specs}/*` and the dated entries
below. Both are records of what was true when written.

---

## 2026-08-13

### The internal identifiers get the new name too

The rename entry below drew the line at user-visible strings and left `@roaster/*`, the repo, the
Worker and the D1 database alone, on the grounds that renaming them breaks the deployment URL and
Google's redirect URI for no user-visible gain. That line was moved deliberately: a codebase whose
every import reads `@roaster/shared` keeps teaching the wrong name to whoever opens it next, and
the breakage it avoids is breakage §3 of `ROADMAP.md` was going to cause anyway.

**Renamed with no runtime effect** (this change): `@roaster/{web,worker,shared}` →
`@danyeowa/*` across 50 files, the root package name, the README and CLAUDE.md headings, and the
fr24 scraper's user-agent (`RoasterMeBot/1.0` → `DanyeowaBot/1.0`).

`ROASTER_API` became `DANYEOWA_API`, but the old name is **still read as a fallback** — that
variable is set in `~/.config/roaster-me/env` on a machine this repo cannot edit, and a rename
that silently repoints the harvester at the default URL is worse than an alias that never expires.

**Deliberately still `roaster`:** `docs/superpowers/{plans,specs}/*` are a frozen archive.
Rewriting a historical document to say something it did not say makes it useless as a record.
(`docs/rules/*` was in this set until 2026-08-19, when it was deleted outright — see the open
questions below. The archive argument survives it: git history holds the text, and unlike a file
in `docs/` nobody has to be warned away from it.)

The user-agent was previously left alone because changing it changes the fingerprint fr24 sees.
That is still true; it was accepted because the string is self-identifying either way, and a
scraper announcing a name the project no longer uses is its own kind of wrong.

---

## 2026-08-13 (later)

### The app is called danyeowa

`roaster·me` was a misspelling. The word for a cabin-crew monthly schedule is **roster**; a
roaster roasts coffee. Fixing the spelling was considered and rejected: `rosterme.com` is taken,
and **RosterMe** (rosterme.au) is a live Australian security-guard rostering product — moving to
the correct spelling meant moving into a more crowded name, not out of one.

**danyeowa** (다녀와) is the Korean send-off to someone leaving: *go, and come back*. English
"goodbye" carries no promise of return; 다녀와 does. That is the whole product — the partner of a
cabin crew member, tracking when she goes and when she is back.

Checked before buying: no app, service or company of that name (Korean or English search, both
app stores), all of `danyeowa.com/.kr/.co.kr` unregistered, and Revised Romanisation gives exactly
one spelling, so the name survives being heard and typed. `danyeowa.com` registered 2026-08-13.

**Rejected, with reasons worth keeping:**
- `vaivem.app` — "vai e vem" describes the product exactly, but Brazil already has 8+ ride-hailing
  and taxi apps called Vaivem / Vai Vem, in the same app stores our first users browse.
- `pouso.app` — landing, and a resting place. Clean on the stores, but "Pouso Alegre" (a city in
  Minas Gerais) owns 70-80% of search results for the word.
- `saudade` — every good TLD taken, and it names absence where this app is about return.

**Renamed:** wordmark, `<title>`, PWA manifest name/short_name, the push fallback title, the
share-view footer, the install banner, and the email From. **Not renamed:** the repo, the Worker
(`roaster-me`), the D1 database (`roaster-me-db`), and the `@roaster/*` package names — internal
identifiers whose rename would break the deployment URL, Google's registered redirect URI, and
every installed PWA, for zero user-visible gain.

**The wordmark is one text node.** It was briefly `danyeo<span>wa</span>` to keep the old two-tone
treatment, which made the accessible name compute as "danyeo wa" — two words to a screen reader.
Splitting a word mid-token is not the same as splitting `roaster` / `·me` at a boundary. Do not
reintroduce it.

---

## 2026-08-13

### The Trips tab is gone, and the trip detail screen with it

The tab listed every upcoming duty as **one row per leg**, so a two-leg pairing was two rows and a
roster of three trips read as a ranked chart of things that have no ranking. Everything on it —
next duty, the legs, report time, edit, delete — the calendar already showed, one tap away.

Deleted: `TripsView.tsx`, `TripDetail.tsx`, both test files, the tab itself. The calendar is now
the only roster surface: the month grid is the overview, the day card is the detail.

**What went with it, deliberately:** `TripDetail` was the only entry point to leg-level time
editing, so editing one leg's departure by hand is gone. The day card's pencil re-runs the whole
lookup-and-create pipeline instead, which replaces the trip rather than nudging one leg. If
per-leg editing is wanted again, it belongs on the day card, not on a resurrected screen.

`PATCH /api/flights/:id` was left in place at first, then deleted the same day once it was clear
nothing called it — the app never did again, and the harvester's arrival corrections go through
`/api/ingest/*`. `LegPatchSchema` went with it. Reinstating per-leg editing means a new route and
a new schema; that is the right cost for a feature nobody is asking for yet.

**What this cost the e2e suite, and what it bought.** Three specs used the Trips tab to count
duties and to clear leftovers between runs. Counting rendered rows could never tell one four-leg
trip from two two-leg trips — precisely the distinction the turnaround tests exist to prove — so
those assertions now read `/api/trips` directly (`rosterTrips` in `e2e/helpers.ts`). Cleanup was a
loop that clicked a row, a delete and a confirm up to five times with every timeout swallowed; a
cleanup that quietly failed surfaced later as an unrelated assertion failing. `clearRoster` deletes
through the API and throws if the roster is not actually empty.

Edit coverage would otherwise have dropped to zero — the deleted leg edit was the only edit path
under test — so `roster.spec.ts` now drives the day card's pencil instead.

---

## 2026-08-12

### Crew sharing: one table, and read-only by construction

A crew member invites another by email; once accepted, each can open the other's calendar and
neither can change it. Badges above the grid switch whose roster is on screen.

**One table, not two.** `crew_invites` carries `acceptedAt` / `acceptedByUserId` / `revokedAt`, so
an accepted, unrevoked invite *is* the pairing. A separate `crew_links` table would hold exactly
the same fact twice, and the two can disagree; there is no state a second table would record.

**Read-only is structural, not a flag.** No mutation route accepts a user id — every one resolves
the owner from the session, as they already did. The only route that takes an id is
`GET /api/crew/:userId/trips`, which is a read. The `readOnly` prop on the day card hides controls
that would fail anyway; deleting that prop cannot grant write access, it can only put a dead
button on screen. This is why the feature adds no `?userId=` to `/api/trips`: a parameter that
selects whose data you get is one copy-paste away from appearing on a write route.

**Not found, never forbidden.** Accepting an invite addressed to someone else, revoking one you
are not party to, and reading a roster you are not paired with all answer 404 — the same answer an
unknown id gets. A 403 would confirm the invite exists and hint at who it is for.

**Emails are stored and compared lower-cased.** better-auth does not normalise case, so an invite
to `Sam@…` accepted by a session on `sam@…` would otherwise silently never match.

**The invite is claimed by signing in, not by holding the token.** Invites carry a token, but
accepting goes by invite id and checks the session's email — so a leaked link grants nothing, and
there is no unauthenticated accept route to attack. The receiving side is told about the invite in
the app; no email is sent. *Not built:* a push or email notification of a pending invite.

### Boot splash: one DOM node, dismissed by `#root:not(:empty)`

The splash lives in `index.html` **outside** `#root`, and this is the whole dismissal mechanism:

```css
#root:not(:empty) + #boot-splash { opacity: 0; visibility: hidden; }
```

`App` renders `null` while `/api/me` is in flight, so an empty `#root` is what holds the splash up.
Do not "simplify" either half — moving the splash back inside `#root` means React's first render
destroys it, which is what forced the earlier two-copy version (an inline copy for the first frame
plus a React `<Splash/>` for the fetch wait, matched by hand down to the letter-spacing).
`web/src/boot-splash.test.ts` guards the rule, the DOM order, and the hard-coded colours, which
cannot use `var(--color-*)` because they paint before `tokens.css` exists.

`:empty` rather than `:has([data-app-ready])`: it needs no React attribute and no `:has()` support.

---

## 2026-08-10 → 08-11

### Calendar grid: direction on the day cell

Each trip day shows a glyph plus a station code — `↗BKK` outbound, `↙AKL` return, `⇄BKK`
turnaround, `→` outstation sector, `·` layover — instead of the old featureless dot. Days are
bucketed by **home-tz local departure**, matching the span marks the grid already drew.

The colour rides on the **glyph, not the code**: `accent` on `accent-soft` measures 3.97:1, under
the 4.5:1 text minimum, while a glyph is a non-text graphic held to 3:1. The station code is
`text-ink` (14.7:1). Marker is 12px, measured 29.9px wide in a 44.3px cell.

Optimistically-added days keep a plain dot — they have no legs yet, and the layover fallback would
otherwise label them with an unrelated trip's station.

### Trip card: departure board + always-visible timeline (scroll-expand was removed)

Collapsed, the card is a board: route headline, `flight · date`, then `REPORT` (amber) / `DEP` /
`ARR` rows, duration closing right-aligned.

**Amended: `ARR` spells out the landing day (`Fri 28 · 00:09`); the `+N` superscript is gone.**
`+N` counts from the *departure station's* date, so reading it meant taking a date in Argentina
and adding two — arithmetic nobody does correctly at 1am, and this card's second reader is
someone deciding when to leave for the airport. Shown only when the landing falls on a different
local day than the departure; a same-day sector still shows the time alone.

`flight · date` is read in the **home** zone for the same reason, so the date on the card is the
date of the calendar cell it sits under. The length badge (`· 2 days`) counts the same span the
calendar paints, so the card and the grid cannot disagree about how many cells a duty owns.

**Scrolling past 60px collapses the calendar and expands the card into a day timeline** — leave
home → report → departs → lands, with destination city and body-clock shift, and layover rows
between sectors. Scroll back above 30px to restore.

**Scroll-to-expand was built, shipped, and then removed on 2026-08-11.** It defeated itself:
collapsing the calendar removed the very scroll that triggered it, so the browser clamped scrollY
back below the restore threshold and it un-collapsed ~60ms later.

```
t=0ms    y=200  docH=913  timeline=false
t=60ms   y=57   docH=721  timeline=TRUE     <- collapses, document shrinks, y clamped
t=120ms  y=0    docH=870  timeline=false    <- below restore threshold, reverts
```

That flicker was what the user reported as "there's no animation" — no easing would have fixed it.
The timeline is now simply always visible; there is space for it. The weekly `DayStrip` that
appeared on collapse went with it (unwanted), and the month header no longer disappears.
**Do not reintroduce a scroll-driven collapse without solving the shrink-clamp feedback loop.**
- **Report time was removed from the card, then deliberately restored.** It was first cut as a
  run-on sentence (`Report 08:10 · leave home 07:15 · now`); the board gives it a labelled row that
  reads at a glance. Don't remove it again without checking this line.
  *Superseded 2026-08-31:* report time is off the card entirely, on the user's instruction — the
  crew member reads it in her airline's own app. See "Report time is off the card entirely".
- Trip length shows only on multi-day pairings; "1 day" on a turnaround is noise.
- **Weather and sunset were prototyped and deliberately not built.** They need airport lat/lng
  (a seed column) plus a weather API. Two fabricated tiles are worse than none.

### Entry: airline code is a setting; adding is inline; the bottom sheet is gone

- The airline code (`EK`) renders as **static text**; only digits are typed. Stored in
  `localStorage` via `lib/airlinePrefix`, editable in Settings. Two-letter IATA only.
- **Tapping an empty day shows the flight-code input immediately.** No "Add trip" button, no sheet.
- **`DaySheet` was deleted outright**, not left dead — with it went second-tap-to-open, the scrim,
  Escape-to-dismiss, and the whole sheet concept. The tab bar's **+** selects today instead.
- A save **closes the form**. Turnarounds still work because the second flight is appended to the
  same preview *before* saving (`AppendFlightControl`), so one save covers both legs.
- **Manual entry is a miss-only fallback** — the link appears only after a lookup actually returns
  empty. Removing it entirely was rejected: an unknown flight would become unaddable.
- Editing happens **inline on the card** via the pencil. Saving reuses `useTripEntry` — the same
  lookup-and-create pipeline as adding — and is **create-then-delete**, never the reverse: a failed
  lookup must not be able to destroy a roster entry.

### Times are read-only where the provider owns them

Schedule times come from the provider chain, so the day card's leg panel is read-only.
`TripDetail` (Trips tab) still edits them **on purpose** — it is the only path to correct a wrong
provider time.

### Sign-in is one surface

Landing and login were separate views, and the code was a third. Now a single screen: the form is
already on it, and sending a code swaps the button **in place** for the code field with the email
still visible. `Login.tsx` was folded into `Landing.tsx`; `App.tsx` lost its `signedOutView` state.

The code field genuinely cannot appear before the code is sent — the server must issue it first.
The bug was making that a *page change* rather than the form growing.

### Zoom is disabled app-wide (accessibility trade-off, requested explicitly)

Focusing a field blew the layout up on iPhone: two inputs set no font size and inherited ~13px, and
**iOS zooms any focused control under 16px while ignoring `maximum-scale`/`user-scalable`**. Three
mechanisms, because no single one covers every case: a 16px floor on form controls, `touch-action:
manipulation` for double-tap, and cancelled `gesturestart/change/end` for pinch.

The 16px floor alone fixes the reported bug. The pinch/double-tap blocks are the "disable it
entirely" part and can be dropped independently.

### Schedule lookups are fast; don't build async reconciliation for them

Measured: **cold 300–500ms, warm 17–25ms, unknown-flight miss ~360ms** (then negative-cached).

A "save now, reconcile later" design was considered and rejected at this latency — `origin`, `dest`,
`dep_utc`, `arr_utc`, `report_utc`, `dep_tz`, `arr_tz` are all `NOT NULL`, so it would need nullable
times, a pending status, a reconciler job, a pending UI state, and push alerts that skip pending
trips. Revisit only if real-world numbers are seconds, not milliseconds.

### CI publishes a preview URL per PR

`wrangler versions upload` publishes a version without promoting it, so each PR gets its own HTTPS
URL, commented on the PR (and edited in place on re-runs).

**The preview shares production's D1** — trips added through a preview link are real. Isolating that
needs a second database and a per-environment binding swap.

Google sign-in **cannot** work on previews: each version gets a new hostname and Google requires
exact redirect URIs.

### e2e was broken for a month and nobody noticed

Every run since Plan 10 failed instantly: `createAuth` throws without `GOOGLE_CLIENT_*`, so
`wrangler dev` 500'd on every request and Playwright timed out before running a single spec. The
job's generated `.dev.vars` predated the Google-login commit. Dummy values fixed it.

**The "known flake" was not a flake.** That belief deferred gating for a day. Checking the actual
run history: every red run from 08-07 to 08-10 14:35 was this same boot bug, and the single
genuine failure after the fix (08-10 17:13) was an assertion on the bottom sheet — code deleted two
changes later. 18 consecutive green runs followed, across the card redesign, the inline-add rework,
the sheet deletion and the timeline.

So as of 2026-08-11 `e2e` is **blocking** and `deploy` needs `[check, e2e]`. Unit tests and
typecheck cannot see the class of bug that actually reaches users here, so deploying on `check`
alone was shipping past the only gate that would catch them.

### Schedules are harvested locally with real Chrome, not fetched by the Worker

The Worker's `fetch()` to flightradar24 is fingerprint/egress-blocked: a production lookup for
EK247 recorded a miss, while the identical page fetched by a real, locally-launched Chrome on a
dev machine returns every row (27, for EK247's two legs across the sampled dates). The block is
on the caller, not the flight — `worker/src/schedule-providers/scrape-fr24.ts` stays in place as
the cache-miss fallback (unchanged), but a Worker fetch to fr24 can no longer be trusted to
populate the cache going forward.

`scripts/fetch-schedules.mjs` is the workaround: launch real Chrome via Playwright, parse **every**
row on a flight's fr24 page (not just the first, and not just "now" — the Worker provider's two
known gaps), group by date to detect multi-leg services, and batch-write the result into
production D1's `flight_schedules` with `source='local-fetch'` (distinct from `seed-verified` and
`live-scrape`). Pure parsing/derivation lives in `scripts/lib/fr24-parse.mjs`, unit-tested against
`worker/test/fixtures/fr24-ek247.html` in `worker/test/schedule-providers/fr24-local-parse.test.ts`.

Default is dry-run (prints the SQL, writes nothing); `--apply` is required to actually write.
Resumable via `scripts/.fetch-progress.json` (gitignored) so an interrupted multi-hundred-flight
sweep can pick back up. Run: `node scripts/fetch-schedules.mjs --flights EK247,EK49` or
`node scripts/fetch-schedules.mjs --range 0-999 --limit 50 --apply`.

---

### The lookup failure chain, in the order it was actually diagnosed

EK247 failing in the app took four wrong turns before the real cause. Recorded so the next person
skips them:

1. "Negative cache is hiding it" — partly true, cleared it, still failed.
2. "The provider chain is misconfigured" — true but not the cause: `AERODATABOX_KEY` is set neither
   locally nor in production, so that fallback returns `null` immediately. The chain is one
   provider, not two.
3. "fr24 blocks datacentre IPs" — **wrong**, and stated too confidently from a `curl` 403. CI (a
   GitHub runner) resolved a flight through the same code path, and production holds 7 rows with
   `source='live-scrape'`. The block is on client fingerprint, not address class.
4. "The parser can't handle a two-leg service" — **wrong**. Run against the real captured page it
   parses fine; it just returns the SECOND leg (`GIG→EZE 17:25`) and discards the first, because it
   keeps only the first table row and ignores the requested date entirely (`_dateIso` unused).

The actual cause: **production's fetch now receives a bot-challenge page**, proven by production
recording a miss for EK247 two minutes after its negative-cache row was cleared, while the same URL
in real Chrome returned 27 rows. The `live-scrape` rows are historical.

Method note worth keeping: every wrong turn above was a claim made from one measurement without
checking whether the instrument could see what was being claimed.

### Verification traps that produced confidently wrong reports

Three separate times this session a working feature was reported broken because the *measurement*
was wrong, not the code:

- `boundingBox()` ignores clipping by an ancestor's `overflow:hidden`, so a fully collapsed element
  still reports its natural height.
- `page.screenshot({fullPage:true})` **scrolls the page and resets it**, so anything measured
  afterwards reads as though the user scrolled back to the top.
- A bundle fetched mid-deploy returns the *previous* hash, which looks exactly like a failed deploy.
  Re-request with cache-busting before concluding.

Also: this repo's jsdom has **no `PointerEvent` constructor**, so `fireEvent.pointerDown` degrades
to a bare `Event` with undefined coordinates — gesture tests can pass while proving nothing. The
swipe tests dispatch `MouseEvent` typed as pointer events to work around it.

## Recurring traps

- **The calendar-width regression has happened three times.** Cause each time: a container that
  centres *every* child, so anything full-width must opt out. Patching with `w-full` on the
  calendar only holds until someone inserts a wrapper between them. Fixed at the cause by removing
  the centring; verify by measuring grid width against container width, not by looking.
- **A stale `wrangler dev` serves an old bundle**, so a change looks missing. Cost several wrong
  conclusions, including one reported to the user as a regression.
- **A bundle fetched mid-deploy returns the previous hash**, which looks exactly like a failed
  deploy. Re-request with cache-busting before concluding anything.

## Open questions

- ~~Is scroll-to-expand reachable on a short roster?~~ **Resolved by removing the feature** — the
  real defect was the shrink-clamp loop above, not reachability.
- ~~**The Worker still records a miss when its fetch was BLOCKED.**~~ **Resolved 2026-08-19.**
  The blocked/timed-out path was already correct (`schedule.ts` only records a miss when a
  provider ANSWERED `absent`). A *second* path was not: when a provider RESOLVED a flight but an
  airport could not be learned, it recorded a miss too — claiming the provider said the flight
  does not exist, when it had said the opposite. That row self-shields, because
  `isRecentlyMissed` short-circuits ahead of the provider chain so the `clearMiss` that would
  undo it never runs, and seeding the airport does not clear it (ingest clears by flight number).
  Not a corner case: airport metadata comes from aerodatabox alone and scrape-fr24 — the first
  provider in the chain — never supplies it. Fixed by not caching there at all.
- ~~**`TripForm.tsx`** is a near-duplicate of `useTripEntry`…~~ **Resolved by deleting it**
  (2026-08-19). It could not render: `showTripForm` started `false` and every call to its setter
  passed `false`. 884 lines carrying a duplicate of the airport guard and the un-normalised
  flight-number bug, reachable by nothing.
- ~~**`docs/rules/*`** is flagged but not deleted…~~ **Deleted 2026-08-19.** Measured 112
  mentions of a stack this project does not use against 10 of the one it does, with zero for
  Hono or Drizzle. Git history is the archive; a document every reader has to be warned away
  from costs more than it records. Content preserved at `1bc3242`.

## Not built, deliberately

| Thing | Why not |
|---|---|
| Weather / sunset at destination | Needs airport lat/lng seed column + weather API. Prototyped as placeholders only. |
| A public share link | Deleted in #53. `/share/:token` needed no account, so the link *was* the credential. Sharing is now an invitation to a named address that must sign in. Reinstating a public link would undo that on purpose. |
| Destination news | Goes stale fast, real cost, unclear value next to an arrival time. |
| Async schedule reconciliation | See latency numbers above. |
| Second D1 for previews | Only worth it if previews get heavy use. |

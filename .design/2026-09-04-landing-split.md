# Landing split: marketing at `/`, sign-in at `/signin`

Date: 2026-09-04
Status: spec, awaiting review
Supersedes: the "Rejected: a separate marketing page" entry at `docs/DECISIONS.md:49-53`

---

## Why this reverses a recorded decision

`docs/DECISIONS.md:49-53` rejected this split on 2026-09-03. Its reasoning was entirely about
SEO: no channel sends traffic to `/`, and a marketing route in this SPA serves an empty `#root`
to a crawler, "so it would not have bought the SEO that is the only reason to want it."

Two things are wrong with that today, and one of them was never considered.

**Never considered: the returning user.** The rejection assumed the page keeps its current
shape. The redesign approved on 2026-09-04 adds four content blocks, which takes the signed-out
page from 1197px to 2670px at 390px wide, with the sign-in form at the bottom. Measured in
`.design/` mockup renders on 2026-09-04. A user who is signed out on a new device now scrolls
past a full marketing pitch, or hunts for an anchor, to reach a form that today sits at y=293.
That is a regression the split fixes and nothing else does. It has nothing to do with SEO.

**Wrong in direction: "SEO is the only reason to want it."** Googlebot executes JavaScript and
indexes SPA content on a second-pass render, so the empty `#root` costs less with Google than
the entry implies. The crawlers that do *not* execute JavaScript — GPTBot, ClaudeBot,
PerplexityBot, OAI-SearchBot — are the ones that matter more now, and for them the page is
nothing at all.

Verified against production on 2026-09-04: `curl https://danyeowa.com/` returns 8057 bytes. With
tags stripped, the only content is the title `danyeowa` and the meta description. Zero body copy.

Not verified: which crawlers actually request `danyeowa.com`, and whether each executes
JavaScript. That is a claim about bot behaviour, not something measured on this site.
Cloudflare's bot analytics can answer the first half and should be checked before anyone treats
the AI-crawler argument as load-bearing.

---

## Scope

1. Split the signed-out surface into two routes.
2. Redesign the marketing route per the approved departure-board direction.
3. Prerender `/` at build time so a non-JS crawler receives the copy.
4. Add `SoftwareApplication` JSON-LD to `web/index.html`.

Out of scope: pricing (nothing charges), a router library, SSR, any change to
`/invite/:token`.

---

## Routes

| Path | Signed out | Signed in |
|---|---|---|
| `/` | Marketing page. No form. | The app, unchanged. |
| `/signin` | Board sample + email OTP + Google. | Redirect to `/`. |
| `/invite/:token` | `InviteLanding`, unchanged. | `InviteLanding`, unchanged. |

Routing stays hand-rolled. `web/src/App.tsx:20` already does one `pathname.startsWith` check for
the invite prefix; this adds one `pathname === "/signin"` comparison beside it. No new
dependency.

`wrangler.jsonc` sets `not_found_handling: "single-page-application"` and
`run_worker_first: ["/api/*"]`, so `/signin` is served `index.html` with no configuration change.

---

## Components

**`web/src/Marketing.tsx`** (new) — the whole signed-out marketing surface. Sections in order:
masthead with a CTA, the pain statement, the two audience cards, how-it-works in three steps,
arrival alerts, the plain-facts strip, footer. Content and copy are fixed in
`.design/` mockup renders from 2026-09-04.

**`web/src/Landing.tsx`** (slimmed) — keeps the departure-board sample, the email OTP flow, the
Google button, and the invite branch. Loses the pitch. `LandingPitch.tsx` is deleted; its content
moves into `Marketing.tsx` rewritten.

**`web/src/App.tsx`** — one added path branch, plus the loading change below.

### The loading change, and why it is required

`App.tsx:89` returns `null` while `me === "loading"`, so nothing renders until `/api/me`
answers. With a prerendered `/`, that produces a visible three-step flash: prerendered copy →
blank → React copy.

So on `/`, the marketing page renders immediately without waiting for `/api/me`, and swaps to
the app only once that call reports a session. This is also what makes prerendering possible at
all: the prerender pass needs no API to be running.

The `me === "loading"` guard stays for every other path, because it is what holds `index.html`'s
boot splash on screen — the splash is dismissed by `#root:not(:empty)`.

---

## Prerendering

A post-build step renders the built `/` in a headless browser and writes the resulting HTML back
over `web/dist/index.html`.

Playwright is already a devDependency and CI already runs `npx playwright install --with-deps
chromium` for the e2e job (`.github/workflows/ci.yml:33`). No new dependency.

Sequence:

1. `vite build` produces `web/dist`.
2. The script serves `web/dist` statically on a local port.
3. It loads `/`, waits for the marketing content, and snapshots
   `document.documentElement.outerHTML`.
4. It writes that over `web/dist/index.html`.

The snapshot keeps the original `<script type="module" src="/assets/index-<hash>.js">` tag,
because it is snapshotting the live DOM. React then mounts over the prerendered markup with
`createRoot` and re-renders it.

**Deliberate simplification with a known ceiling:** this is prerendering without hydration.
`createRoot` discards the prerendered markup and rebuilds it rather than adopting it. The
rendered result is identical, so there is nothing to see, but it does mean the markup is thrown
away. Upgrade path is `hydrateRoot`, which is worth doing only if a measurement shows the
re-render costs something. It will carry a `ponytail:` comment naming this.

### Interaction with the deploy verification

`.github/workflows/ci.yml:168` derives the expected bundle name with
`basename "$(ls web/dist/assets/index-*.js | head -1)"` and then checks production serves it.
Prerendering does not rename or remove any file in `web/dist/assets/`, and the snapshot preserves
the script tag, so this verification keeps working unchanged.

This is the single riskiest claim in the spec and it gets a real check: the implementation runs
the build locally and confirms the prerendered `index.html` still references the same hashed
bundle that `ls web/dist/assets/index-*.js` reports.

---

## JSON-LD

A `SoftwareApplication` block in `web/index.html`'s `<head>`, as
`<script type="application/ld+json">`. It is static markup, so it needs neither the split nor the
prerender, and it lands in the raw HTML every crawler already receives.

Fields: `name`, `description`, `applicationCategory`, `operatingSystem`, `url`. No
`aggregateRating` and no `offers` — there are no ratings and nothing charges, and inventing
either is exactly the class of claim `docs/FEATURES.md` exists to prevent.

---

## Content rules

Every claim on the marketing page maps to a **Live** row in `docs/FEATURES.md`.

Included: flight-number lookup; the free window between landing and next report; the layover
brief; the landing-day date problem; arrival alerts at 60/30/0 minutes; per-person crew sharing;
PWA install; account deletion.

Excluded, and the reason: report-time alerts and live flight status are **Built**, not verified
in production. "Share a roster by link" was **removed 2026-08-14**. Pricing, because nothing
charges.

Two copy corrections carried in: the `she`/`her` in the second audience card is removed, and the
first card's paragraph is shortened.

---

## Test plan

Every check below is proven failing first, by reverting the change it guards.

**Unit — `web/src/App.test.tsx`**
- `/` signed out renders the marketing page and no email field.
- `/signin` signed out renders the email field and no marketing content.
- `/signin` signed in redirects to `/`.
- `/invite/:token` renders `InviteLanding` on both paths, unchanged.
- `/` renders marketing before `/api/me` resolves.

**Unit — `web/src/Marketing.test.tsx`** (new)
- All four content blocks present.
- No occurrence of `she`, `her`, or `hers` in rendered text.

**Unit — `web/src/Landing.test.tsx`** (reduced)
- The pitch assertions move to `Marketing.test.tsx`. The OTP flow and invite-branch tests stay.

**E2E — `e2e/layout.spec.ts`**
- No horizontal scroll at 390px, on both `/` and `/signin`.
- Every form control computes to ≥16px; touch targets ≥44px.
- The calendar-width invariant is untouched by this work but stays asserted.

**E2E — prerender**
- Fetch the built `/` with JavaScript disabled and assert the pain heading and all three
  how-it-works steps are in the HTML. This is the only check that actually proves the prerender
  did anything; asserting it in a JS-enabled browser would pass with or without it.

**Helper**
- `e2e/helpers.ts:158` changes `page.goto("/")` to `page.goto("/signin")`. All 14 specs inherit
  it. `helpers.ts:166` matches `{ name: "Sign in", exact: true }`, so the marketing CTA must not
  be labelled exactly `Sign in` or that selector becomes ambiguous.

---

## Risks

1. **The prerender snapshot breaks the deploy verification.** Checked explicitly by a local build
   before the PR, as described above.
2. **The prerender step makes CI slower or flaky.** It adds a browser launch to the build. If it
   proves flaky it can be made non-fatal — a failed prerender should leave a working SPA, not a
   failed deploy. The script writes `index.html` only on a successful snapshot.
3. **Nobody arrives at `/` regardless.** Prerendering makes the page readable, not findable.
   Stated here so the split is not later judged against traffic it was never going to produce.

---

## Follow-ups, deliberately not in this change

- `hydrateRoot` instead of `createRoot`, if the re-render is ever measured to cost something.
- The dark-mode board contrast problem recorded at `docs/DECISIONS.md:55-57` — the board
  (`#0b0d12`) sits close to the dark ground (`#15171c`). This change moves the board but does not
  fix that, and it is still open.
- Pricing, when something charges.

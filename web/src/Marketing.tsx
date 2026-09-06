/**
 * The public marketing surface, shown at `/` to a signed-out visitor. Sign-in lives on its own
 * route (`/signin`) and this page carries no form at all.
 *
 * `docs/DECISIONS.md` recorded the opposite on 2026-09-03 — "rejected: a separate marketing page
 * at `/`". That entry argued the split entirely from SEO, and SEO is not why this exists. The
 * reason is the returning user: a signed-out visitor on a new device should not scroll past a
 * full pitch to reach a form. Once the pitch and the form are both on one surface, one of them
 * has to be second, and neither audience tolerates being second.
 *
 * Every claim on this page maps to a row marked **Live** in `docs/FEATURES.md`. Report-time
 * alerts and live flight status are deliberately absent: both are **Built**, meaning deployed but
 * never confirmed against reality, and this is the one page where an unverified claim is a
 * promise to a stranger. Sharing by link is absent because it was removed on 2026-08-14.
 *
 * No images, unchanged from LandingPitch's reasoning: every screenshot of this app is a
 * screenshot of somebody's real roster, and the two things worth showing — a report time and a
 * route — are text.
 *
 * Semantic tokens only. The departure board keeps the licensed exception it already had in
 * `Landing.tsx`: fixed dark values in both themes, because it is meant to read as a physical
 * airport board rather than as themed app chrome. The board's typographic grammar — tabular
 * figures, uppercase tracked labels, dashed rules — carries through the rest of the page, but
 * its colours do not.
 */

/** The two people this is for, written as their questions, because that is how they arrive. */
const AUDIENCES = [
  {
    who: "If you fly",
    line: "Where you are, and how long you are free.",
    detail:
      "Your airline's app stops at the gate. This carries on: the hours between landing and the next report, and a layover brief you can paste into any assistant.",
  },
  {
    who: "If you are waiting at home",
    line: "When they land, and which day that actually is.",
    detail:
      "A red-eye out of Melbourne on the 20th walks in on the 21st. Here the date is spelled out with its weekday, so nobody is adding a day in their head at 1am.",
  },
];

/** Deliberately does not mention arrival alerts, which have their own block below. Two
 * near-identical claims 600px apart read as a duplication bug rather than as emphasis — the
 * mistake 2026-09-03 caught in the hero tagline, before it shipped. */
const STEPS = [
  {
    n: "01",
    title: "Type a flight number.",
    detail: "Digits only — the airline prefix is a setting.",
  },
  {
    n: "02",
    title: "The schedule fills itself in.",
    detail: "Route, departure, the landing day, and the layover in between.",
  },
  {
    n: "03",
    title: "Invite one person.",
    detail: "By email. They read your calendar; no one can change your roster but you.",
  },
];

const FACTS = [
  {
    label: "Free",
    // Not "there is nothing to buy", which becomes a bait the day anything charges. The shape
    // recorded in DECISIONS.md on 2026-09-02 attaches payment to SHARING, never to a crew
    // member's own roster — so say that, and it stays true either way.
    detail: "Nothing to buy. If that ever changes it will be for sharing, never for your own roster.",
  },
  {
    label: "No airline login",
    detail: "It never asks for your crew-portal password. Flight numbers are all it takes.",
  },
  { label: "Installs", detail: "Add to Home Screen, iOS included." },
];

/** Board rows as data so the markup below stays one map instead of four near-identical divs. */
const BOARD = [
  { term: "EK448", value: "DXB → AKL" },
  { term: "DEP", value: "10:45" },
  { term: "LANDS", value: "06:20⁺¹" },
];

export default function Marketing() {
  return (
    <div
      data-testid="marketing"
      className="entrance flex w-full max-w-5xl flex-col gap-12 text-left"
    >
      <header className="stagger-1 flex items-center justify-between gap-4 border-b border-dashed border-edge pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">danyeowa</h1>
        {/* Not labelled "Sign in": e2e/helpers.ts matches `{ name: "Sign in", exact: true }` for
            the OTP submit button, and a second exact match would break every spec that signs in. */}
        <a
          href="/signin"
          className="num flex min-h-[44px] items-center rounded border border-edge bg-card px-4 text-xs uppercase tracking-[0.14em] text-ink transition-colors duration-[120ms] hover:border-accent"
        >
          Get started
        </a>
      </header>

      <section className="stagger-2 grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start lg:gap-14">
        <div className="flex flex-col gap-4">
          <p className="text-xl text-ink-muted sm:text-2xl">
            A cabin-crew roster the people at home can read too.
          </p>
          <h2 className="max-w-xl text-2xl font-semibold leading-snug text-ink sm:text-3xl">
            The roster is written for the airline
          </h2>
          <p className="max-w-xl text-ink-muted">
            It arrives in airline time. A flight filed on the 20th walks in on the 21st. The free
            hours between landing and the next report are not on it anywhere. And whoever is
            meeting you at arrivals gets a screenshot they cannot read.
          </p>
        </div>

        {/* Static illustrative sample, not live schedule data — same panel as Landing's, and
            dark in both themes for the same reason. */}
        <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-[#0b0d12] p-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <p className="num text-xs uppercase tracking-[0.2em] text-white/50">Next duty</p>
            <p className="num text-xs uppercase tracking-[0.2em] text-white/30">Sat 20 Sep</p>
          </div>
          <dl className="num flex flex-col text-sm text-white/90">
            {BOARD.map((row) => (
              <div
                key={row.term}
                className="flex items-baseline justify-between border-b border-dashed border-white/15 py-1.5"
              >
                <dt className="text-white/50">{row.term}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            {/* The value this app adds, and the only amber on the panel. The row used to read
                REPORT; report came off the day card on 2026-08-31 because a crew member reads it
                in her airline's own app. */}
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-white/50">FREE</dt>
              <dd className="text-[#ffd57e]">22h 35m</dd>
            </div>
          </dl>
          <div className="num mt-2 flex items-baseline justify-between border-t border-white/10 pt-2 text-xs text-white/40">
            <span>THEN EK449</span>
            <span>AKL → DXB · MON 22</span>
          </div>
        </div>
      </section>

      <section className="stagger-3 flex flex-col gap-4">
        <p className="num text-xs uppercase tracking-[0.16em] text-ink-muted">
          A roster reads differently depending on who holds it
        </p>
        {/* One column at 390px, two from `sm` up. Nothing on this screen may scroll sideways on
            a phone — an invariant this project has broken more than once. */}
        <div className="grid gap-4 sm:grid-cols-2">
          {AUDIENCES.map((a) => (
            <div
              key={a.who}
              className="flex flex-col gap-2 rounded-lg border border-edge bg-card p-5"
            >
              <p className="num text-xs uppercase tracking-[0.14em] text-ink-muted">{a.who}</p>
              <p className="text-lg font-semibold leading-snug text-ink">{a.line}</p>
              <p className="text-sm text-ink-muted">{a.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-10 lg:grid-cols-[1fr_20rem] lg:gap-14">
        <div className="flex flex-col gap-3">
          <p className="num text-xs uppercase tracking-[0.16em] text-ink-muted">How it works</p>
          <ol className="flex flex-col">
            {STEPS.map((s, i) => (
              <li
                key={s.n}
                className={`flex gap-4 py-4 ${
                  i < STEPS.length - 1 ? "border-b border-dashed border-edge" : ""
                }`}
              >
                <span className="num text-sm text-ink-muted">{s.n}</span>
                <div className="flex flex-col gap-1">
                  <p className="font-semibold text-ink">{s.title}</p>
                  <p className="text-sm text-ink-muted">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* `self-start` so the card sizes to its content instead of stretching to the height of
            the three steps beside it. */}
        <div className="flex flex-col gap-2 self-start rounded-lg border border-edge bg-card p-5 lg:mt-8">
          <p className="num text-3xl text-report">60 · 30 · 0</p>
          <p className="font-semibold text-ink">A notification before they land</p>
          <p className="text-sm text-ink-muted">
            Minutes out — so the person collecting you leaves at the right time, not the time
            printed on the roster.
          </p>
        </div>
      </section>

      {/* gap-px over bg-edge draws the two dividers without three separate border rules. */}
      <section className="grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-3">
        {FACTS.map((f) => (
          <div key={f.label} className="flex flex-col gap-1 bg-card p-5">
            <p className="num text-xs uppercase tracking-[0.14em] text-ink-muted">{f.label}</p>
            <p className="text-sm text-ink">{f.detail}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col items-center gap-4 border-t border-dashed border-edge pt-10">
        <p className="text-center text-lg text-ink-muted">
          It takes one flight number to see whether this is for you.
        </p>
        <a
          href="/signin"
          className="flex min-h-[44px] items-center rounded bg-accent px-6 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98]"
        >
          Get started
        </a>
      </section>

      <footer className="flex flex-col gap-2 border-t border-dashed border-edge pt-6">
        <p className="max-w-xl text-sm text-ink-muted">
          Your roster is yours. It is not sold, and it is never shown to anyone you have not
          invited by name. Delete your account from Settings and the roster, invites and devices
          go with it.
        </p>
        <a
          href="mailto:korlogan94@gmail.com"
          className="num text-xs uppercase tracking-[0.14em] text-ink-muted underline"
        >
          korlogan94@gmail.com
        </a>
      </footer>
    </div>
  );
}

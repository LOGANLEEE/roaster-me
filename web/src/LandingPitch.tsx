/**
 * What the app is, for someone who has never seen it — shown under the sign-in form on the
 * signed-out screen.
 *
 * NOT shown to someone arriving on an invite link. They already know why they are here: a named
 * person shared a roster with them. Selling to them would replace an answer with a pitch.
 *
 * No images, deliberately. Every screenshot of this app is a screenshot of somebody's real
 * roster, and the two things worth showing — a report time and a route — are text. A picture of
 * text is slower to load, cannot be translated, and reads as nothing to a screen reader.
 *
 * Semantic tokens only. This screen has to survive both themes, and the one licensed exception
 * (the dark departure board in `Landing.tsx`) is already spent.
 */

/** The two people this is for, written as their questions, because that is how they arrive. */
const AUDIENCES = [
  {
    who: "If you fly",
    line: "Where you are, and how long you are free.",
    detail:
      "Your airline's app already has your report time and your gate. This has what it does not: the hours between landing and the next report, and a layover brief you can paste into any assistant.",
  },
  {
    who: "If you are waiting at home",
    line: "When she is back, and where she is now.",
    detail:
      "The flight home almost never lands on the day the roster files it under — a red-eye out of Melbourne on the 20th walks in on the 21st. Shared, the date is spelled out with its weekday, so nobody is adding a day in their head at 1am.",
  },
];

/**
 * Placeholder pricing. The names and numbers are Logan's to set; what is claimed here is the
 * SHAPE — a free tier that is genuinely usable alone, with payment attached to sharing, which
 * is the part that costs a push subscription and a second person's reads.
 */
const TIERS = [
  {
    name: "Solo",
    price: "Free",
    per: "",
    blurb: "The roster, for you.",
    features: [
      "Month calendar with every duty",
      "Departure and landing times, down-route rest",
      "Layover brief to copy",
      "Installs like an app, opens offline",
    ],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Shared",
    price: "$3",
    per: "/month",
    blurb: "One roster, the people who need it.",
    features: [
      "Everything in Solo",
      "Share with up to 3 people",
      "They see when you land — not your report time",
      "A push when a duty changes",
    ],
    cta: "Share a roster",
    featured: true,
  },
  {
    name: "Crew",
    price: "$8",
    per: "/month",
    blurb: "For people who fly together.",
    features: [
      "Everything in Shared",
      "No limit on people",
      "Read each other's rosters",
      "Export a month",
    ],
    cta: "Talk to us",
    featured: false,
  },
];

function Check() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0 text-ok"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function LandingPitch() {
  return (
    <section
      data-testid="landing-pitch"
      className="mt-14 flex w-full max-w-3xl flex-col gap-12 text-left"
    >
      <div className="flex flex-col gap-6">
        <h2 className="text-center text-xl font-semibold text-ink">
          A roster reads differently depending on who is holding it
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {AUDIENCES.map((a) => (
            <div
              key={a.who}
              className="flex flex-col gap-2 rounded-lg border border-edge bg-card p-5"
            >
              <p className="text-xs uppercase tracking-[0.12em] text-ink-muted">{a.who}</p>
              <p className="text-lg font-semibold text-ink">{a.line}</p>
              <p className="text-sm text-ink-muted">{a.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div data-testid="landing-pricing" className="flex flex-col gap-6">
        <h2 className="text-center text-xl font-semibold text-ink">Plans</h2>
        {/* One column at 390px, three from `sm` up. Nothing on this screen may scroll sideways
            on a phone — an invariant this project has broken more than once. */}
        <div className="grid gap-4 sm:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              data-testid={`tier-${tier.name.toLowerCase()}`}
              className={[
                "flex flex-col gap-4 rounded-lg border p-5",
                tier.featured ? "border-accent bg-accent-soft" : "border-edge bg-card",
              ].join(" ")}
            >
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-ink">{tier.name}</p>
                <p className="flex items-baseline gap-1">
                  <span className="num text-3xl font-semibold text-ink">{tier.price}</span>
                  {tier.per && <span className="num text-sm text-ink-muted">{tier.per}</span>}
                </p>
                <p className="text-sm text-ink-muted">{tier.blurb}</p>
              </div>

              <ul className="flex flex-col gap-2">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-ink">
                    <Check />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              {/* Points at the sign-in field already on this page rather than routing anywhere.
                  The form is the only way in, and a second route would be a second thing to
                  keep working. */}
              <a
                href="#landing-email"
                className={[
                  "mt-auto flex min-h-[44px] items-center justify-center rounded px-3 text-sm font-medium transition-[background-color,transform] duration-[120ms] active:scale-[0.98]",
                  tier.featured
                    ? "bg-accent text-ground hover:brightness-110"
                    : "border border-edge text-ink hover:bg-raised",
                ].join(" ")}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
        <p className="text-center text-xs text-ink-muted">
          Prices are not live yet — nothing on this page charges anything.
        </p>
      </div>
    </section>
  );
}

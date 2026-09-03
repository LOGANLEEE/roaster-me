/**
 * What the app is, for someone who has never seen it — shown between the hero and the sign-in
 * form on the signed-out screen. It sits ABOVE the form on purpose: the page used to ask for an
 * email 300px before it said what it was, which is the wrong order for the only visitor who
 * needs telling.
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
 *
 * The pricing table was removed on 2026-09-03. Three tiers ran to 1098px — 46% of a 2367px page
 * — to advertise prices the block itself admitted were not live, on a page whose real job is to
 * explain the app and let someone in. The shape it claimed (a free tier usable alone, payment
 * attached to sharing) is recorded in `DECISIONS.md` and costs nothing to rebuild once anything
 * actually charges.
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

export default function LandingPitch() {
  return (
    <section
      data-testid="landing-pitch"
      className="flex w-full max-w-3xl flex-col gap-5 text-left"
    >
      <h2 className="text-center text-xl font-semibold text-ink">
        A roster reads differently depending on who is holding it
      </h2>
      {/* One column at 390px, two from `sm` up. Nothing on this screen may scroll sideways on a
          phone — an invariant this project has broken more than once. */}
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
    </section>
  );
}

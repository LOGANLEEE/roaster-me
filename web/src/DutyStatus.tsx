import { formatDuration, formatLocal, localDateKey } from "@danyeowa/shared";
import type { Flight } from "@danyeowa/shared";
import { humanDateLabel } from "./lib/dateLabel";
import type { LayoverRest } from "./lib/layoverBrief";

/**
 * The answer, above the detail.
 *
 * Two people read this app and they ask different questions. The crew member wants to know
 * where she is and how long she is free — her airline's own app already gives her the report
 * time and the e-gate, so restating those is the one thing this card must not spend its
 * headline on. The person at home wants to know when she is back and where she is right now.
 *
 * So the hero is DIFFERENT BY READER, and deliberately so: hers is a DURATION, his is a
 * DATE AND TIME. That split is not a style preference — it is forced by the roster. Measured
 * over her real September, 5 of 16 duties cross a home-local date boundary and ALL FIVE of
 * them are the flight home (EK192, EK66, EK353, EK409, EK708). The day a duty is filed under
 * is therefore never the day she walks in, so a card that leads with the roster's own date
 * answers his only question wrongly, every single time. His hero spells the arrival date out
 * with its weekday instead, and never asks him to add a day to something.
 *
 * The down-route state comes in as a prop rather than being derived here, and that is not
 * laziness — it is the only way it can be right. Her real roster stores each sector as its OWN
 * trip (EK408 out on the 19th and EK409 home on the 21st are `isis-03e5ebf6` and
 * `isis-cb5ed55d`, two rows), so a component handed one trip's legs sees a single sector and
 * can never observe the gap between two. `layoverRests` in lib/layoverBrief.ts walks every leg
 * across every trip precisely because of that, and the day card is already given its result.
 *
 * Deliberately prints NO clock that the timeline below it already prints. A sector strip here
 * was tried first and reverted: it restated every dep and arr, which is exactly what the
 * DEP/ARR board deleted in 829b673 did, and `CalendarHome.test.tsx` guards it by counting that
 * each time appears once. The flight numbers and both stations stay on the timeline; this block
 * says only what the timeline cannot — which of those sectors is happening now, and how far in.
 */

type Leg = Flight;

type DutyState =
  | { kind: "upcoming"; leg: Leg }
  /** In the air on `leg`. */
  | { kind: "airborne"; leg: Leg; fromUtc: string; toUtc: string }
  /** On the ground away from base, between two sectors of this duty. */
  | { kind: "between"; landed: Leg; next: Leg; fromUtc: string; toUtc: string }
  | { kind: "done"; leg: Leg };

/**
 * Which sector she is on, or between, at `nowMs`.
 *
 * "Not landed yet" is the test for a duty being current, matching the rule CalendarHome uses
 * to pick the next duty — a duty must not vanish from its own card the moment she reports for
 * it. The two are kept in step on purpose; they disagreed once and the card was titled by one
 * trip and coloured by another.
 */
export function dutyState(legs: readonly Leg[], nowMs: number): DutyState | null {
  const ordered = [...legs].sort((a, b) => a.legSeq - b.legSeq);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return null;

  if (nowMs < Date.parse(first.depUtc)) return { kind: "upcoming", leg: first };
  if (nowMs > Date.parse(last.arrUtc)) return { kind: "done", leg: last };

  for (const [i, leg] of ordered.entries()) {
    const dep = Date.parse(leg.depUtc);
    const arr = Date.parse(leg.arrUtc);
    if (nowMs >= dep && nowMs <= arr) {
      return { kind: "airborne", leg, fromUtc: leg.depUtc, toUtc: leg.arrUtc };
    }
    const next = ordered[i + 1];
    if (next && nowMs > arr && nowMs < Date.parse(next.depUtc)) {
      return { kind: "between", landed: leg, next, fromUtc: leg.arrUtc, toUtc: next.reportUtc };
    }
  }
  return null;
}

/** 0–1, clamped. Drives `scaleX` on the rail, never `width` — width is layout, and this
 *  animates on mount. */
function fraction(fromUtc: string, toUtc: string, nowMs: number): number {
  const from = Date.parse(fromUtc);
  const to = Date.parse(toUtc);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.min(1, Math.max(0, (nowMs - from) / (to - from)));
}

export function DutyStatus({
  legs,
  homeTz,
  now,
  layoverRest,
  /** True when this is someone else's roster — the person at home reading hers. */
  readOnly = false,
}: {
  legs: readonly Leg[];
  homeTz: string;
  now: Date;
  /** The down-route rest this day falls inside, when it does. Crosses trips, so it cannot be
   * derived from `legs`. */
  layoverRest?: LayoverRest | null;
  readOnly?: boolean;
}) {
  const nowMs = now.getTime();
  const ordered = [...legs].sort((a, b) => a.legSeq - b.legSeq);
  const state = dutyState(ordered, nowMs);
  const last = ordered[ordered.length - 1];
  if (!state || !last) return null;

  // Standing on the ground away from base beats every per-trip state: she has landed and the
  // next report is still ahead, which is the one question her airline's app cannot answer.
  const restingNow =
    layoverRest &&
    nowMs >= Date.parse(layoverRest.arrUtc) &&
    nowMs < Date.parse(layoverRest.nextReportUtc)
      ? layoverRest
      : null;

  // His hero, whatever the state: when she is back. Spelled with its weekday, because the
  // roster's own date is the departure's, and every homecoming in her September lands on the
  // day after that.
  const backLabel = `${humanDateLabel(localDateKey(last.arrUtc, homeTz), homeTz)} · ${formatLocal(last.arrUtc, homeTz)}`;

  let kicker: string;
  let hero: string;
  let sub: string | null = null;
  let rail: { fromUtc: string; toUtc: string } | null = null;

  if (restingNow) {
    kicker = `Down-route · ${restingNow.station}`;
    hero = readOnly
      ? backLabel
      : `${formatDuration(now.toISOString(), restingNow.nextReportUtc)} free`;
    sub = readOnly
      ? `now in ${restingNow.station}, ${formatLocal(now.toISOString(), restingNow.arrTz)} local`
      : `until report · ${restingNow.outboundFlightNo}`;
    return (
      <StatusBlock
        kicker={kicker}
        hero={hero}
        sub={sub}
        rail={{ fromUtc: restingNow.arrUtc, toUtc: restingNow.nextReportUtc }}
        nowMs={nowMs}
      />
    );
  }

  switch (state.kind) {
    case "upcoming":
      // No clock here: the timeline below owns every dep and arr, and restating one is how
      // the DEP/ARR board started.
      kicker = `Departs from ${state.leg.origin}`;
      // Just the destination. "MEL · 13h 10m" was tried and is a lie by omission: with each
      // sector stored as its own trip, `last.arrUtc` is this flight's landing, not the end of
      // the pairing, so the figure read as "away for 13h" when she is gone three days.
      hero = readOnly ? backLabel : last.dest;
      sub = readOnly ? "back home" : `leaves in ${formatDuration(now.toISOString(), state.leg.depUtc)}`;
      break;
    case "airborne":
      kicker = `Airborne · ${state.leg.origin} → ${state.leg.dest}`;
      // Hers is a duration, his is a date and time — the whole split, applied here.
      hero = readOnly ? backLabel : `${formatDuration(now.toISOString(), state.leg.arrUtc)} to go`;
      sub = readOnly ? "back home" : `lands in ${state.leg.dest}`;
      rail = { fromUtc: state.fromUtc, toUtc: state.toUtc };
      break;
    case "between": {
      kicker = `Down-route · ${state.landed.dest}`;
      // Free until REPORT, not until departure. A 25h layover with a 19:40 report is 22h 35m
      // of usable time, and that difference is a whole evening.
      const free = formatDuration(now.toISOString(), state.next.reportUtc);
      hero = readOnly ? backLabel : `${free} free`;
      sub = readOnly
        ? `now in ${state.landed.dest}, ${formatLocal(now.toISOString(), state.landed.arrTz)} local`
        : `report ${formatLocal(state.next.reportUtc, state.next.depTz)}`;
      rail = { fromUtc: state.fromUtc, toUtc: state.toUtc };
      break;
    }
    case "done":
      kicker = `Landed · ${state.leg.dest}`;
      hero = state.leg.dest === ordered[0]!.origin ? "Home" : state.leg.dest;
      sub = backLabel;
      break;
  }

  return <StatusBlock kicker={kicker} hero={hero} sub={sub} rail={rail} nowMs={nowMs} />;
}

function StatusBlock({
  kicker,
  hero,
  sub,
  rail,
  nowMs,
}: {
  kicker: string;
  hero: string;
  sub: string | null;
  rail: { fromUtc: string; toUtc: string } | null;
  nowMs: number;
}) {
  return (
    <section data-testid="duty-status" className="flex flex-col gap-1">
      <p data-testid="duty-status-kicker" className="num text-sm text-ink-muted">
        {kicker}
      </p>
      <p data-testid="duty-status-hero" className="ds-hero num text-2xl font-semibold text-ink">
        {hero}
      </p>
      {sub && <p className="num text-sm text-ink-muted">{sub}</p>}

      {rail && (
        <div
          data-testid="duty-status-rail"
          className="ds-bar mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
        >
          {/* scaleX, never width: width is layout, and this runs on every mount. */}
          <i
            className="block h-full origin-left rounded-full bg-accent"
            style={{ "--ds-p": fraction(rail.fromUtc, rail.toUtc, nowMs) } as React.CSSProperties}
          />
        </div>
      )}
    </section>
  );
}

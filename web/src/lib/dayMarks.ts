import { localDateKey, type TripSpan } from "@danyeowa/shared";

/** What a duty day is, relative to home base - drives the calendar cell's arrow glyph so
 * outbound vs return vs turnaround are readable without tapping the day. */
export type DayKind =
  /** Leaves home base and doesn't come back that day. */
  | "outbound"
  /** Lands back at home base. */
  | "return"
  /** Out of home base and back on the same local day. */
  | "turnaround"
  /** Flies between two outstations (no home-base leg). */
  | "sector"
  /** Down-route day with no departure - slip/layover. */
  | "layover";

/** `code` is the station the glyph points at: the outstation reached (outbound/turnaround/
 * sector), the station flown home from (return), or the station slept at (layover). */
export type DayMark = { kind: DayKind; code: string };

type LegLike = { origin: string; dest: string; depUtc: string; arrUtc: string };
type TripLike = { flights: LegLike[] };

/**
 * Classifies each day of a trip span. `spanDays` are the local (in `homeTz`) dates the
 * calendar already marks as trip days - days with no departure fall back to "layover",
 * carrying the station of the last leg that had landed by then.
 */
export function dutyDayMarks(
  trips: readonly TripLike[],
  homeTz: string,
  base: string,
  spanDays: Iterable<string>,
): Map<string, DayMark> {
  const allLegs = trips
    .flatMap((trip) => trip.flights)
    .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc));

  const legsByDepDay = new Map<string, LegLike[]>();
  for (const leg of allLegs) {
    const key = localDateKey(leg.depUtc, homeTz);
    const bucket = legsByDepDay.get(key);
    if (bucket) bucket.push(leg);
    else legsByDepDay.set(key, [leg]);
  }

  const marks = new Map<string, DayMark>();
  for (const iso of spanDays) {
    const legs = legsByDepDay.get(iso);

    if (!legs || legs.length === 0) {
      // Layover: where the crew is standing that day = destination of the last leg that had
      // already landed. Only reached for days inside a span, so a leg always precedes it.
      const landed = allLegs.filter(
        (leg) => localDateKey(leg.arrUtc, homeTz) <= iso,
      );
      const last = landed[landed.length - 1];
      if (last) marks.set(iso, { kind: "layover", code: last.dest });
      continue;
    }

    const leavesBase = legs.find((leg) => leg.origin === base);
    const returnsBase = legs.find((leg) => leg.dest === base);
    const lastLeg = legs[legs.length - 1]!;

    if (leavesBase && returnsBase)
      marks.set(iso, { kind: "turnaround", code: leavesBase.dest });
    else if (leavesBase)
      marks.set(iso, { kind: "outbound", code: lastLeg.dest });
    else if (returnsBase)
      marks.set(iso, { kind: "return", code: legs[0]!.origin });
    else marks.set(iso, { kind: "sector", code: lastLeg.dest });
  }

  return marks;
}

export type AwaySpan = { firstDepUtc: string; endUtc: string };

/**
 * The stretch a trip should paint on the calendar, as `tripDaysInMonth` wants it.
 *
 * Not simply first departure to last arrival. A leg that lands at base ends the stretch when she
 * BOARDS it, not when the wheels touch: the flight home from a long layover routinely lands
 * after home-local midnight, and running the span to the landing paints the morning she is
 * already asleep in her own bed as another day down-route. EK248 landed 00:09 on the 28th and
 * the 28th came out marked "layover · DXB" — a day at the outstation she was never at.
 *
 * `legs` must already be sorted by `legSeq`.
 */
export function calendarSpan(legs: readonly LegLike[], base: string): TripSpan | null {
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) return null;
  return {
    firstDepUtc: first.depUtc,
    endUtc: last.dest === base ? last.depUtc : last.arrUtc,
  };
}

/**
 * The stretches when the crew member is away from home base — walked across trips, not within one.
 *
 * A pairing is usually two trips: EK247 out on the 22nd, EK248 back on the 28th. The layover days
 * between belong to neither trip, so per-trip spans leave them blank and they read exactly like
 * the days she is at home. For the person waiting at home that is the wrong answer — she is not
 * flying, but she is also not coming back.
 *
 * Walking the legs base-to-base finds those days: away opens on a departure from base and closes
 * on the flight home — at the moment she boards it, not when it lands, for the reason spelled
 * out on `calendarSpan`.
 *
 * Two cases the walk has to survive, both caused by a roster that is only ever partly known:
 *
 * - **A departure from base while a span is still open.** She got home some way this roster does
 *   not record, so the open span is closed at the last landing seen rather than swallowing the
 *   days in between. Without this, one unclosed short trip would paint every day up to the next
 *   return as "away".
 * - **A span still open at the end.** It runs to the last landing known and no further. Guessing
 *   past that would invent days she may already be home for.
 */
export function awaySpans(
  trips: readonly TripLike[],
  base: string,
): AwaySpan[] {
  const legs = trips
    .flatMap((trip) => trip.flights)
    .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc));

  const spans: AwaySpan[] = [];
  let openedAt: string | null = null;
  let lastArrUtc: string | null = null;

  for (const leg of legs) {
    if (leg.origin === base) {
      if (openedAt !== null && lastArrUtc !== null)
        spans.push({ firstDepUtc: openedAt, endUtc: lastArrUtc });
      openedAt = leg.depUtc;
    }
    lastArrUtc = leg.arrUtc;
    if (openedAt !== null && leg.dest === base) {
      // Closes where she boards the flight home, not where it lands — same reason as
      // `calendarSpan`, and it has to match or the two mark sources disagree by a day.
      spans.push({ firstDepUtc: openedAt, endUtc: leg.depUtc });
      openedAt = null;
    }
  }

  if (openedAt !== null && lastArrUtc !== null)
    spans.push({ firstDepUtc: openedAt, endUtc: lastArrUtc });
  return spans;
}

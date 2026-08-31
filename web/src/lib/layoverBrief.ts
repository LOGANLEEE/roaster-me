import { clockShiftHours, formatDuration, formatLocal, localDateKey } from "@danyeowa/shared";
import type { Flight } from "@danyeowa/shared";
import type { DayForecast } from "./weather";

type LegLike = Pick<
  Flight,
  "flightNo" | "origin" | "dest" | "depUtc" | "arrUtc" | "reportUtc" | "depTz" | "arrTz"
>;
type TripLike = { flights: LegLike[] };

/**
 * A stay on the ground away from base: she landed somewhere, and the next thing she flies
 * leaves from that same station.
 *
 * Deliberately walked across ALL legs rather than within one trip. The rest that matters is
 * usually between two trips of a pairing — EK412 lands SYD on the Friday, EK413 leaves SYD on
 * the Saturday — and a per-trip walk cannot see it. Same reason `awaySpans` exists.
 */
export type LayoverRest = {
  /** IATA she is standing in. */
  station: string;
  inboundFlightNo: string;
  outboundFlightNo: string;
  arrUtc: string;
  arrTz: string;
  nextReportUtc: string;
  nextDepUtc: string;
  nextDepTz: string;
  /** When the flight OUT of the layover lands. Not part of the rest itself — it only sets how
   * far `restForDay` reaches, so the panel stays on screen for the whole duty the layover
   * belongs to, including a red-eye's landing day. */
  nextArrUtc: string;
  /** Hours from landing to the next departure. What a roster calls the layover. */
  hours: number;
  /**
   * Hours from landing to the next REPORT — the number she actually plans against, and the
   * one thing here no generic travel prompt can know. A 25h layover with a 19:40 report is
   * 22h 35m of usable time, and the difference is a whole evening.
   */
  freeHours: number;
  /** Body-clock shift of the leg that brought her in, e.g. +6. */
  clockShift: number;
};

/**
 * Below this much free time, a stop on the ground is transit, not a layover.
 *
 * Set by what the panel is FOR: somewhere to go and time to get there. EK247 stops at Rio for
 * two hours on the way to Buenos Aires and the first version called that a layover, then
 * offered "5m free until report" and a city guide for a city she never leaves the airport of.
 * Six hours is the point where leaving is worth the trip in and out — a product judgement, not
 * a regulation, and the one number to change if it reads wrong in use.
 */
export const MIN_LAYOVER_FREE_HOURS = 6;

/**
 * Every ground rest away from base, ordered by arrival.
 *
 * Two guards, both because a roster is only ever partly known:
 *
 * - **The next leg must depart the station she landed at.** If it doesn't, she got between the
 *   two some way this roster does not record, and describing that gap as a layover would be an
 *   invention.
 * - **Report must fall after landing.** Bad or half-entered data otherwise yields a negative
 *   free-time figure, which is worse than showing nothing.
 */
export function layoverRests(trips: readonly TripLike[], base: string): LayoverRest[] {
  const legs = trips
    .flatMap((trip) => trip.flights)
    .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc));

  const rests: LayoverRest[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const inbound = legs[i]!;
    const outbound = legs[i + 1]!;
    if (inbound.dest === base) continue;
    if (inbound.dest !== outbound.origin) continue;

    const arrivedMs = Date.parse(inbound.arrUtc);
    const reportMs = Date.parse(outbound.reportUtc);
    const departsMs = Date.parse(outbound.depUtc);
    if (!Number.isFinite(arrivedMs) || !Number.isFinite(reportMs)) continue;
    if (reportMs <= arrivedMs) continue;
    const freeHours = (reportMs - arrivedMs) / 3_600_000;
    if (freeHours < MIN_LAYOVER_FREE_HOURS) continue;

    rests.push({
      station: inbound.dest,
      inboundFlightNo: inbound.flightNo,
      outboundFlightNo: outbound.flightNo,
      arrUtc: inbound.arrUtc,
      arrTz: inbound.arrTz,
      nextReportUtc: outbound.reportUtc,
      nextDepUtc: outbound.depUtc,
      nextDepTz: outbound.depTz,
      nextArrUtc: outbound.arrUtc,
      hours: (departsMs - arrivedMs) / 3_600_000,
      freeHours,
      clockShift: clockShiftHours(inbound.depUtc, inbound.depTz, inbound.arrUtc, inbound.arrTz),
    });
  }
  return rests;
}

/**
 * The rest covering `isoDate`, if any.
 *
 * Days are keyed in `homeTz`, not the station's zone, because that is what the calendar grid
 * itself is keyed in — the cell she tapped has to be the rest she gets back.
 *
 * The window runs from the landing that starts the rest to the LANDING of the flight out of
 * it, not to that flight's departure. EK192 leaves Lisbon at 14:20 on the 1st and lands Dubai
 * at 01:30 on the 2nd; both days show the same trip card, so ending the window at the
 * departure made one of those two cards carry the Lisbon panel and the other not, for no
 * reason a reader could see. The panel now lives on every day of the duty the layover feeds.
 */
export function restForDay(
  rests: readonly LayoverRest[],
  isoDate: string,
  homeTz: string,
): LayoverRest | null {
  return (
    rests.find(
      (rest) =>
        localDateKey(rest.arrUtc, homeTz) <= isoDate &&
        isoDate <= localDateKey(rest.nextArrUtc, homeTz),
    ) ?? null
  );
}

/**
 * The text handed to the clipboard, for the crew member to paste into whichever assistant she
 * already uses.
 *
 * This is the whole feature. Weather, attractions, local transport and what's on are four
 * separate integrations with four separate licences, coverage gaps and running costs; the
 * assistant she already uses answers all four, and the only thing it cannot supply is the
 * roster context — which is exactly what this app has. So the app packs the context and stays
 * out of the answering business. Nothing here is asserted that the app does not already know,
 * so there is no tile that can be wrong.
 *
 * English regardless of device language: the prompt is read by a model, not by her, and every
 * assistant replies in whatever language she follows up in.
 */
export function formatLayoverBrief(
  rest: LayoverRest,
  opts: { city?: string | null; hotel?: string | null; forecast?: readonly DayForecast[] | null } = {},
): string {
  const city = opts.city?.trim();
  const hotel = opts.hotel?.trim();
  const shift = `${rest.clockShift >= 0 ? "+" : ""}${rest.clockShift}h`;
  const forecast = opts.forecast?.length ? opts.forecast : null;

  // With a real forecast in hand there is no point asking for one: an assistant answering from
  // training data gives a seasonal average, which is what this replaces. Without it, the
  // question stays — a vague answer beats no answer, as long as nothing pretends otherwise.
  const weatherLines = forecast
    ? [
        "",
        "WEATHER (actual forecast, Open-Meteo)",
        ...forecast.map(
          (day) =>
            `  ${day.date}  ${Math.round(day.tempMinC)}–${Math.round(day.tempMaxC)}°C · ` +
            `${day.label} · rain ${day.rainChance == null ? "—" : `${day.rainChance}%`} · ` +
            `sunset ${day.sunset.slice(11, 16)}`,
        ),
      ]
    : [];
  const weatherQuestion = forecast
    ? "3. What to pack given that forecast"
    : "3. The weather across those dates, and what to pack";

  return [
    "I'm cabin crew on a layover. Answer practically and briefly.",
    "",
    `CITY    ${city ? `${city} · ${rest.station}` : rest.station}`,
    `IN      ${formatLocal(rest.arrUtc, rest.arrTz, { withDate: true })} local — ${rest.inboundFlightNo}`,
    `REPORT  ${formatLocal(rest.nextReportUtc, rest.nextDepTz, { withDate: true })} local`,
    `OUT     ${formatLocal(rest.nextDepUtc, rest.nextDepTz, { withDate: true })} local — ${rest.outboundFlightNo}`,
    `FREE    ${formatDuration(rest.arrUtc, rest.nextReportUtc)} from landing to report`,
    `CLOCK   ${shift} against where I flew in from`,
    hotel
      ? `HOTEL   ${hotel}`
      : "HOTEL   crew hotel, location unknown — assume somewhere reasonably central",
    ...weatherLines,
    "",
    "For exactly those hours, tell me:",
    "1. Getting around from the hotel: roughly what a taxi or rideshare costs per km,",
    "   which app works here, and whether a metro or train beats it",
    "2. Three things worth doing that fit the time I actually have",
    weatherQuestion,
    "4. Anything on in the city while I'm there",
    "",
    "Under 200 words. Assume 8h sleep and one proper meal. I take the crew shuttle from the",
    "airport, so skip that leg.",
  ].join("\n");
}

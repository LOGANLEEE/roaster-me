import { addDaysIso, localDateKey } from "@danyeowa/shared";
import type { LayoverRest } from "./layoverBrief";

export type DayForecast = {
  /** Station-local calendar date, YYYY-MM-DD. */
  date: string;
  tempMaxC: number;
  tempMinC: number;
  /** Highest hourly chance of precipitation that day, percent. Null when the model gives
   * none — rendered as "—", never as 0%, which would be a claim we cannot make. */
  rainChance: number | null;
  /** WMO 4677 code, as Open-Meteo returns it. */
  code: number;
  label: string;
  /** Local ISO timestamps, already in the station's zone (the API is asked for it). */
  sunrise: string;
  sunset: string;
};

/**
 * WMO 4677, collapsed to what a crew member packing a bag actually needs to tell apart. The
 * distinction between "moderate" and "dense drizzle" changes nothing she would do; rain versus
 * thunderstorm versus snow does.
 */
const WMO_LABELS: ReadonlyArray<readonly [readonly number[], string]> = [
  [[0], "Clear"],
  [[1], "Mainly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67], "Rain"],
  [[80, 81, 82], "Rain showers"],
  [[71, 73, 75, 77, 85, 86], "Snow"],
  [[95, 96, 99], "Thunderstorm"],
];

export function weatherLabel(code: number): string {
  for (const [codes, label] of WMO_LABELS) if (codes.includes(code)) return label;
  return "Unsettled";
}

/**
 * The station-local dates the rest covers, landing day through departure day inclusive.
 *
 * Keyed in the STATION's zone, not home base's: she is standing there, and "what is Saturday
 * like" means Saturday where her feet are.
 */
export function layoverDates(rest: LayoverRest): string[] {
  const first = localDateKey(rest.arrUtc, rest.arrTz);
  const last = localDateKey(rest.nextDepUtc, rest.nextDepTz);
  const dates: string[] = [];
  // A layover is days, not weeks; the cap only stops a corrupt pair spinning forever.
  for (let iso = first, i = 0; iso <= last && i < 14; iso = addDaysIso(iso, 1), i++) {
    dates.push(iso);
  }
  return dates;
}

/** A forecast is a nicety on a roster screen; it never gets to hold anything up. */
const FORECAST_TIMEOUT_MS = 3_000;

const cache = new Map<string, DayForecast[]>();

type OpenMeteoDaily = {
  time?: string[];
  weather_code?: number[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
  sunrise?: string[];
  sunset?: string[];
};

/**
 * The forecast for a layover, or null when there isn't one.
 *
 * Open-Meteo only forecasts ~16 days out and answers a date beyond that with an explicit error
 * ("Parameter 'start_date' is out of allowed range from … to …"), which is most of a roster:
 * duties are commonly published a month ahead. Null is the correct and common answer, and the
 * caller must render nothing rather than fall back to a seasonal average — a plausible-looking
 * wrong forecast is exactly why the earlier weather tiles were dropped (DECISIONS 2026-08-18).
 *
 * **Only an answer is cached.** A refusal, a network failure and an out-of-range date are not
 * evidence that no forecast exists — the same station a week later has one. Caching them would
 * blank the tile for the rest of the session (CLAUDE.md: never negative-cache a non-answer).
 *
 * Free, key-less and non-commercial-only; attribution is required by CC BY 4.0 and rendered
 * next to the tile.
 */
export async function fetchLayoverForecast(
  lat: number,
  lng: number,
  tz: string,
  dates: readonly string[],
): Promise<DayForecast[] | null> {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return null;

  const key = `${lat},${lng},${first},${last}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lng}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    `&timezone=${encodeURIComponent(tz)}` +
    `&start_date=${first}&end_date=${last}`;

  let body: { error?: boolean; daily?: OpenMeteoDaily };
  try {
    // Bounded, because nothing on this screen may wait on a third party. A forecast that has
    // not arrived in three seconds is not worth having — the card renders without one, and the
    // next visit asks again (a timeout is a non-answer, so it is never cached).
    //
    // Unbounded, this call sat in flight on the home screen while the e2e suite walked the
    // calendar, and a spec with no headroom left timed out at three minutes.
    const res = await fetch(url, { signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS) });
    if (!res.ok) return null;
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (body.error || !body.daily?.time?.length) return null;

  const daily = body.daily;
  const days: DayForecast[] = [];
  daily.time!.forEach((date, i) => {
    const code = daily.weather_code?.[i];
    const tempMaxC = daily.temperature_2m_max?.[i];
    const tempMinC = daily.temperature_2m_min?.[i];
    // `== null` on purpose: the API sends JSON null for a value it has no answer for, not an
    // absent key, and an `undefined`-only guard lets that null through as a real reading.
    if (code == null || tempMaxC == null || tempMinC == null) return;
    days.push({
      date,
      tempMaxC,
      tempMinC,
      rainChance: daily.precipitation_probability_max?.[i] ?? null,
      code,
      label: weatherLabel(code),
      sunrise: daily.sunrise?.[i] ?? "",
      sunset: daily.sunset?.[i] ?? "",
    });
  });

  if (days.length === 0) return null;
  cache.set(key, days);
  return days;
}

/** Test seam: the session cache would otherwise leak one spec's stub into the next. */
export function __clearForecastCache(): void {
  cache.clear();
}

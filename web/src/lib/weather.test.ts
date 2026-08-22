import { afterEach, describe, expect, it, vi } from "vitest";
import { __clearForecastCache, fetchLayoverForecast, layoverDates, weatherLabel } from "./weather";
import { formatLayoverBrief, layoverRests } from "./layoverBrief";

const OK_BODY = {
  daily: {
    time: ["2026-09-04", "2026-09-05"],
    weather_code: [95, 53],
    temperature_2m_max: [31.1, 33.9],
    temperature_2m_min: [25.9, 26.0],
    precipitation_probability_max: [86, 52],
    sunrise: ["2026-09-04T06:05", "2026-09-05T06:05"],
    sunset: ["2026-09-04T18:26", "2026-09-05T18:25"],
  },
};

// The exact shape Open-Meteo answers a date past its ~16-day horizon with.
const OUT_OF_RANGE = {
  error: true,
  reason: "Parameter 'start_date' is out of allowed range from 2026-05-20 to 2026-09-05",
};

function stubFetch(...responses: Array<{ ok?: boolean; body?: unknown; throws?: boolean }>) {
  const calls = { n: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const r = responses[Math.min(calls.n++, responses.length - 1)]!;
      if (r.throws) throw new Error("network down");
      return { ok: r.ok ?? true, json: async () => r.body } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __clearForecastCache();
});

describe("weatherLabel", () => {
  it("collapses WMO codes to what changes what she packs", () => {
    expect(weatherLabel(0)).toBe("Clear");
    expect(weatherLabel(95)).toBe("Thunderstorm");
    expect(weatherLabel(96)).toBe("Thunderstorm");
    expect(weatherLabel(63)).toBe("Rain");
    expect(weatherLabel(75)).toBe("Snow");
  });

  it("names an unmapped code rather than pretending it is clear", () => {
    expect(weatherLabel(4242)).toBe("Unsettled");
  });
});

describe("layoverDates", () => {
  it("runs landing day through departure day in the STATION's zone", () => {
    const [rest] = layoverRests(
      [
        {
          flights: [
            {
              flightNo: "EK384",
              origin: "DXB",
              dest: "BKK",
              depUtc: "2026-09-04T03:30:00.000Z",
              arrUtc: "2026-09-04T10:15:00.000Z",
              reportUtc: "2026-09-04T02:00:00.000Z",
              depTz: "Asia/Dubai",
              arrTz: "Asia/Bangkok",
            },
          ],
        },
        {
          flights: [
            {
              flightNo: "EK385",
              origin: "BKK",
              dest: "DXB",
              depUtc: "2026-09-05T18:05:00.000Z",
              arrUtc: "2026-09-06T00:00:00.000Z",
              reportUtc: "2026-09-05T16:35:00.000Z",
              depTz: "Asia/Bangkok",
              arrTz: "Asia/Dubai",
            },
          ],
        },
      ],
      "DXB",
    );
    // 18:05Z is 01:05 the NEXT day in Bangkok, so the rest runs 4th → 6th there.
    expect(layoverDates(rest!)).toEqual(["2026-09-04", "2026-09-05", "2026-09-06"]);
  });
});

describe("fetchLayoverForecast", () => {
  it("parses a forecast into per-day rows", async () => {
    stubFetch({ body: OK_BODY });
    const days = await fetchLayoverForecast(13.68, 100.75, "Asia/Bangkok", [
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(days).toHaveLength(2);
    expect(days![0]).toMatchObject({
      date: "2026-09-04",
      tempMaxC: 31.1,
      rainChance: 86,
      label: "Thunderstorm",
    });
  });

  it("returns null for a date past the forecast horizon", async () => {
    stubFetch({ body: OUT_OF_RANGE });
    expect(
      await fetchLayoverForecast(13.68, 100.75, "Asia/Bangkok", ["2026-12-01", "2026-12-02"]),
    ).toBeNull();
  });

  it("believes an error flag over a payload that came with it", async () => {
    // Defensive rather than observed: the real refusal carries no `daily` at all, so without
    // this the flag would be dead code and a future response that set both would be read as
    // real data.
    stubFetch({ body: { error: true, reason: "whatever", daily: OK_BODY.daily } });
    expect(
      await fetchLayoverForecast(13.68, 100.75, "Asia/Bangkok", ["2026-09-04", "2026-09-05"]),
    ).toBeNull();
  });

  it("gives up on a forecast that never arrives, and does not cache the giving up", async () => {
    // A hung request must not sit in flight on the roster screen. AbortSignal.timeout rejects,
    // which lands in the same catch as any other failure — and a timeout is a non-answer, so
    // the next visit asks again rather than inheriting a blank card.
    const calls = { n: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        calls.n += 1;
        if (calls.n === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("TimeoutError")));
          });
        }
        return { ok: true, json: async () => OK_BODY } as unknown as Response;
      }),
    );
    vi.useFakeTimers();
    const args = [13.68, 100.75, "Asia/Bangkok", ["2026-09-04", "2026-09-05"]] as const;
    const pending = fetchLayoverForecast(...args);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await pending).toBeNull();
    vi.useRealTimers();
    expect(await fetchLayoverForecast(...args)).toHaveLength(2);
    expect(calls.n).toBe(2);
  });

  it("returns null when the network fails, rather than throwing at the card", async () => {
    stubFetch({ throws: true });
    expect(
      await fetchLayoverForecast(13.68, 100.75, "Asia/Bangkok", ["2026-09-04", "2026-09-05"]),
    ).toBeNull();
  });

  it("caches an answer", async () => {
    const calls = stubFetch({ body: OK_BODY });
    const args = [13.68, 100.75, "Asia/Bangkok", ["2026-09-04", "2026-09-05"]] as const;
    await fetchLayoverForecast(...args);
    await fetchLayoverForecast(...args);
    expect(calls.n).toBe(1);
  });

  it("NEVER caches a non-answer — the same station has one a week later", async () => {
    // Out of range, then in range. If the refusal were cached the card would stay blank for
    // the rest of the session (CLAUDE.md: never negative-cache a non-answer).
    const calls = stubFetch({ body: OUT_OF_RANGE }, { body: OK_BODY });
    const args = [13.68, 100.75, "Asia/Bangkok", ["2026-09-04", "2026-09-05"]] as const;
    expect(await fetchLayoverForecast(...args)).toBeNull();
    expect(await fetchLayoverForecast(...args)).toHaveLength(2);
    expect(calls.n).toBe(2);
  });

  it("skips a day the model has no temperature for instead of defaulting it to zero", async () => {
    stubFetch({
      body: {
        daily: {
          ...OK_BODY.daily,
          temperature_2m_max: [31.1, null],
          temperature_2m_min: [25.9, null],
        },
      },
    });
    const days = await fetchLayoverForecast(13.68, 100.75, "Asia/Bangkok", [
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(days).toHaveLength(1);
    expect(days![0]!.date).toBe("2026-09-04");
  });
});

describe("formatLayoverBrief with a forecast", () => {
  const [rest] = layoverRests(
    [
      {
        flights: [
          {
            flightNo: "EK384",
            origin: "DXB",
            dest: "BKK",
            depUtc: "2026-09-04T03:30:00.000Z",
            arrUtc: "2026-09-04T10:15:00.000Z",
            reportUtc: "2026-09-04T02:00:00.000Z",
            depTz: "Asia/Dubai",
            arrTz: "Asia/Bangkok",
          },
        ],
      },
      {
        flights: [
          {
            flightNo: "EK385",
            origin: "BKK",
            dest: "DXB",
            depUtc: "2026-09-05T18:05:00.000Z",
            arrUtc: "2026-09-06T00:00:00.000Z",
            reportUtc: "2026-09-05T16:35:00.000Z",
            depTz: "Asia/Bangkok",
            arrTz: "Asia/Dubai",
          },
        ],
      },
    ],
    "DXB",
  );

  const forecast = [
    {
      date: "2026-09-04",
      tempMaxC: 31.1,
      tempMinC: 25.9,
      rainChance: 86,
      code: 95,
      label: "Thunderstorm",
      sunrise: "2026-09-04T06:05",
      sunset: "2026-09-04T18:26",
    },
  ];

  it("puts the real numbers in, so the assistant is not asked to guess them", () => {
    const text = formatLayoverBrief(rest!, { city: "Bangkok", forecast });
    expect(text).toContain("WEATHER (actual forecast, Open-Meteo)");
    expect(text).toContain("2026-09-04  26–31°C · Thunderstorm · rain 86% · sunset 18:26");
  });

  it("stops asking for the weather once it supplies it", () => {
    const withForecast = formatLayoverBrief(rest!, { forecast });
    expect(withForecast).toContain("3. What to pack given that forecast");
    expect(withForecast).not.toContain("3. The weather across those dates");
  });

  it("still asks when there is no forecast, rather than inventing one", () => {
    const without = formatLayoverBrief(rest!, {});
    expect(without).toContain("3. The weather across those dates, and what to pack");
    expect(without).not.toContain("WEATHER");
  });
});

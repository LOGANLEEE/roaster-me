import { describe, expect, it } from "vitest";
import {
  MIN_LAYOVER_FREE_HOURS,
  formatLayoverBrief,
  layoverRests,
  restForDay,
} from "./layoverBrief";

const BASE = "DXB";
const HOME_TZ = "Asia/Dubai";

function leg(
  flightNo: string,
  origin: string,
  dest: string,
  dep: string,
  arr: string,
  report: string,
  depTz: string,
  arrTz: string,
) {
  return { flightNo, origin, dest, depUtc: dep, arrUtc: arr, reportUtc: report, depTz, arrTz };
}

/**
 * The shape the feature exists for: two trips, one pairing. EK412 lands Sydney on the Friday
 * evening, EK413 leaves Sydney on the Saturday night. The rest between them belongs to neither
 * trip, so nothing that walks a single trip can see it.
 *
 * Landing 11:05Z is 21:05 in Sydney; report 09:40Z the next day is 19:40 there. That is
 * 22h 35m of usable time inside a 25h 05m layover — the gap this whole thing is about.
 */
const OUT = {
  flights: [
    leg(
      "EK412",
      "DXB",
      "SYD",
      "2026-08-20T21:00:00.000Z",
      "2026-08-21T11:05:00.000Z",
      "2026-08-20T19:30:00.000Z",
      "Asia/Dubai",
      "Australia/Sydney",
    ),
  ],
};
const BACK = {
  flights: [
    leg(
      "EK413",
      "SYD",
      "DXB",
      "2026-08-22T12:10:00.000Z",
      "2026-08-23T02:00:00.000Z",
      "2026-08-22T09:40:00.000Z",
      "Australia/Sydney",
      "Asia/Dubai",
    ),
  ],
};

describe("layoverRests", () => {
  it("finds the rest between two trips of one pairing", () => {
    const rests = layoverRests([OUT, BACK], BASE);
    expect(rests).toHaveLength(1);
    expect(rests[0]!.station).toBe("SYD");
    expect(rests[0]!.inboundFlightNo).toBe("EK412");
    expect(rests[0]!.outboundFlightNo).toBe("EK413");
  });

  it("counts free time to REPORT, not to departure", () => {
    const [rest] = layoverRests([OUT, BACK], BASE);
    // 25h 05m on the ground, but she is only free for 22h 35m of it.
    expect(rest!.hours).toBeCloseTo(25 + 5 / 60, 5);
    expect(rest!.freeHours).toBeCloseTo(22 + 35 / 60, 5);
  });

  it("reads the body-clock shift off the inbound leg", () => {
    const [rest] = layoverRests([OUT, BACK], BASE);
    expect(rest!.clockShift).toBe(6);
  });

  it("does not call the gap between two trips at home a layover", () => {
    // She lands DXB off EK413 and flies out again three days later. That gap is her own bed,
    // not a layover, and a brief about "things to do in Dubai" would be absurd.
    const NEXT = {
      flights: [
        leg(
          "EK384",
          "DXB",
          "BKK",
          "2026-08-26T03:30:00.000Z",
          "2026-08-26T10:15:00.000Z",
          "2026-08-26T02:00:00.000Z",
          "Asia/Dubai",
          "Asia/Bangkok",
        ),
      ],
    };
    const rests = layoverRests([OUT, BACK, NEXT], BASE);
    expect(rests.map((r) => r.station)).toEqual(["SYD"]);
  });

  it("skips a gap whose next leg departs somewhere else", () => {
    // Lands SYD, next duty starts in MEL. She got between them some way the roster does not
    // record, so calling that a Sydney layover would be an invention.
    const elsewhere = {
      flights: [
        leg(
          "EK407",
          "MEL",
          "DXB",
          "2026-08-22T12:10:00.000Z",
          "2026-08-23T02:00:00.000Z",
          "2026-08-22T09:40:00.000Z",
          "Australia/Melbourne",
          "Asia/Dubai",
        ),
      ],
    };
    expect(layoverRests([OUT, elsewhere], BASE)).toEqual([]);
  });

  it("does not call a transit stop a layover", () => {
    // The real one: EK247 stops at Rio for about two hours on the way to Buenos Aires. It was
    // offered as "Layover · Rio de Janeiro — 5m free until report", with a city guide for a
    // city she never leaves the airport of.
    const VIA_GIG = {
      flights: [
        leg(
          "EK247",
          "DXB",
          "GIG",
          "2026-08-22T04:05:00.000Z",
          "2026-08-22T15:50:00.000Z",
          "2026-08-22T02:35:00.000Z",
          "Asia/Dubai",
          "America/Sao_Paulo",
        ),
        leg(
          "EK247",
          "GIG",
          "EZE",
          "2026-08-22T17:25:00.000Z",
          "2026-08-22T20:50:00.000Z",
          "2026-08-22T15:55:00.000Z",
          "America/Sao_Paulo",
          "America/Argentina/Buenos_Aires",
        ),
      ],
    };
    expect(layoverRests([VIA_GIG], BASE)).toEqual([]);
  });

  it("keeps a rest that clears the threshold", () => {
    const [rest] = layoverRests([OUT, BACK], BASE);
    expect(rest!.freeHours).toBeGreaterThanOrEqual(MIN_LAYOVER_FREE_HOURS);
  });

  it("skips a rest whose report falls before the landing", () => {
    const impossible = {
      flights: [
        leg(
          "EK413",
          "SYD",
          "DXB",
          "2026-08-21T12:00:00.000Z",
          "2026-08-22T02:00:00.000Z",
          "2026-08-21T09:00:00.000Z", // 2h before OUT lands
          "Australia/Sydney",
          "Asia/Dubai",
        ),
      ],
    };
    expect(layoverRests([OUT, impossible], BASE)).toEqual([]);
  });
});

describe("restForDay", () => {
  const rests = layoverRests([OUT, BACK], BASE);

  it("covers the landing day and the departure day", () => {
    expect(restForDay(rests, "2026-08-21", HOME_TZ)?.station).toBe("SYD");
    expect(restForDay(rests, "2026-08-22", HOME_TZ)?.station).toBe("SYD");
  });

  it("reaches the day the flight OUT of the layover lands, not just the day it leaves", () => {
    // EK413 leaves Sydney on the 22nd and touches DXB at 06:00 on the 23rd. Both days render
    // the same trip card, so ending the window at the departure put the Sydney panel on one of
    // the two and not the other, with nothing on screen explaining the difference.
    expect(restForDay(rests, "2026-08-23", HOME_TZ)?.station).toBe("SYD");
  });

  it("returns null outside the rest", () => {
    expect(restForDay(rests, "2026-08-19", HOME_TZ)).toBeNull();
    expect(restForDay(rests, "2026-08-24", HOME_TZ)).toBeNull();
    expect(restForDay(rests, "2026-08-25", HOME_TZ)).toBeNull();
  });
});

describe("formatLayoverBrief", () => {
  const [rest] = layoverRests([OUT, BACK], BASE);

  it("states free time with minutes kept", () => {
    const text = formatLayoverBrief(rest!, { city: "Sydney" });
    expect(text).toContain("FREE    22h 35m from landing to report");
  });

  it("carries the roster context the assistant cannot know", () => {
    const text = formatLayoverBrief(rest!, { city: "Sydney" });
    expect(text).toContain("CITY    Sydney · SYD");
    expect(text).toContain("21 Aug 21:05 local — EK412");
    expect(text).toContain("22 Aug 19:40 local");
    expect(text).toContain("22 Aug 22:10 local — EK413");
    expect(text).toContain("CLOCK   +6h");
  });

  it("falls back to the bare IATA when the city has not resolved", () => {
    expect(formatLayoverBrief(rest!, {})).toContain("CITY    SYD");
  });

  it("says the hotel is unknown rather than inventing one", () => {
    expect(formatLayoverBrief(rest!, {})).toContain("location unknown");
  });

  it("uses the hotel once she gives one", () => {
    const text = formatLayoverBrief(rest!, { hotel: "Rydges Sydney Central" });
    expect(text).toContain("HOTEL   Rydges Sydney Central");
    expect(text).not.toContain("location unknown");
  });

  it("tells the assistant to skip the airport transfer", () => {
    // Crew ride a company shuttle to the hotel; an airport-to-city fare is a wrong answer.
    expect(formatLayoverBrief(rest!, {})).toContain("crew shuttle");
  });
});

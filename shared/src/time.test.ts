import { describe, expect, it } from "vitest";
import {
  clockShiftHours,
  dayOffset,
  formatHours,
  formatLocal,
  layoverHours,
  legDatesFromPicked,
  localDateKey,
  monthGrid,
  relativeUntil,
  reportDefault,
  tripDaysInMonth,
  formatDuration,
  tripProgress,
  wallToUtc,
} from "./time";
import type { TripSpan } from "./time";

describe("formatLocal", () => {
  it("formats time-only (default) in the given IANA tz", () => {
    // 2026-08-10T00:45:00Z in Asia/Dubai (+04:00, no DST) = 04:45
    expect(formatLocal("2026-08-10T00:45:00Z", "Asia/Dubai")).toBe("04:45");
  });

  it("formats with weekday + date + time when opts.withDate is set", () => {
    // 2026-08-10T00:45:00Z in Asia/Dubai = Mon 10 Aug 04:45
    expect(formatLocal("2026-08-10T00:45:00Z", "Asia/Dubai", { withDate: true })).toBe(
      "Mon 10 Aug 04:45",
    );
  });

  it("handles a fractional-offset timezone (Asia/Kathmandu, +05:45)", () => {
    // 2026-08-10T00:00:00Z + 05:45 = 05:45
    expect(formatLocal("2026-08-10T00:00:00Z", "Asia/Kathmandu")).toBe("05:45");
  });

  it("reflects the pre-DST-transition offset just before Europe/London springs forward", () => {
    // 2026-03-29 01:00 UTC is 01:00 GMT (still standard time, transition is at 01:00 UTC)
    expect(formatLocal("2026-03-29T00:30:00Z", "Europe/London")).toBe("00:30");
  });

  it("reflects the post-DST-transition offset just after Europe/London springs forward", () => {
    // 2026-03-29 01:30 UTC -> BST (+1) = 02:30
    expect(formatLocal("2026-03-29T01:30:00Z", "Europe/London")).toBe("02:30");
  });

  it("America/Sao_Paulo has no DST since 2019 - offset stable across a year", () => {
    // -03:00 year round
    expect(formatLocal("2026-01-15T12:00:00Z", "America/Sao_Paulo")).toBe("09:00");
    expect(formatLocal("2026-07-15T12:00:00Z", "America/Sao_Paulo")).toBe("09:00");
  });

  it("formats correctly across a month boundary", () => {
    // 2026-07-31T22:00:00Z in Asia/Dubai (+4) = Aug 1st 02:00
    expect(formatLocal("2026-07-31T22:00:00Z", "Asia/Dubai", { withDate: true })).toBe(
      "Sat 1 Aug 02:00",
    );
  });
});

describe("relativeUntil", () => {
  const now = Date.parse("2026-08-10T00:00:00Z");

  it("returns 'now' for anything under 1 minute away", () => {
    expect(relativeUntil("2026-08-10T00:00:30Z", now)).toBe("now");
  });

  it("returns 'now' for times already in the past", () => {
    expect(relativeUntil("2026-08-09T23:59:00Z", now)).toBe("now");
  });

  it("formats sub-24h durations as 'in Xh Ym'", () => {
    // 11h 08m from now
    expect(relativeUntil("2026-08-10T11:08:00Z", now)).toBe("in 11h 08m");
  });

  it("formats sub-1h durations as 'in Xh Ym' with 0 hours", () => {
    expect(relativeUntil("2026-08-10T00:45:00Z", now)).toBe("in 0h 45m");
  });

  it("formats >=24h durations as 'Xd Yh' (no 'in' prefix, no minutes)", () => {
    // 4d 12h from now
    expect(relativeUntil("2026-08-14T12:00:00Z", now)).toBe("4d 12h");
  });

  it("formats exactly 24h as '1d 0h'", () => {
    expect(relativeUntil("2026-08-11T00:00:00Z", now)).toBe("1d 0h");
  });

  it("rounds down (floors) partial minutes within the sub-24h window", () => {
    // 1h 29m59s -> floors to 1h 29m
    expect(relativeUntil("2026-08-10T01:29:59Z", now)).toBe("in 1h 29m");
  });
});

describe("reportDefault", () => {
  it("returns departure time minus 90 minutes as an ISO UTC string", () => {
    expect(reportDefault("2026-08-10T08:45:00.000Z")).toBe("2026-08-10T07:15:00.000Z");
  });

  it("rolls back across a day boundary", () => {
    expect(reportDefault("2026-08-10T00:30:00.000Z")).toBe("2026-08-09T23:00:00.000Z");
  });

  it("rolls back across a month boundary", () => {
    expect(reportDefault("2026-08-01T00:10:00.000Z")).toBe("2026-07-31T22:40:00.000Z");
  });
});

describe("layoverHours", () => {
  it("computes whole-and-fractional hours between arrival and next departure", () => {
    expect(layoverHours("2026-08-10T08:00:00Z", "2026-08-10T10:30:00Z")).toBe(2.5);
  });

  it("returns 0 when arrival and next departure are simultaneous", () => {
    expect(layoverHours("2026-08-10T08:00:00Z", "2026-08-10T08:00:00Z")).toBe(0);
  });

  it("computes layovers spanning a day boundary", () => {
    expect(layoverHours("2026-08-10T23:00:00Z", "2026-08-11T02:00:00Z")).toBe(3);
  });
});

describe("formatHours", () => {
  it("formats sub-24h as whole hours", () => {
    expect(formatHours(1)).toBe("1h");
    expect(formatHours(23)).toBe("23h");
  });

  it("rounds a fractional value to the nearest whole hour before bucketing", () => {
    expect(formatHours(1.0833333333333333)).toBe("1h");
    // Rounds up to 24h, which then falls into the days-bucket branch.
    expect(formatHours(23.6)).toBe("1d 0h");
  });

  it("formats 24h and above as days + remaining hours", () => {
    expect(formatHours(24)).toBe("1d 0h");
    expect(formatHours(51)).toBe("2d 3h");
  });

  it("clamps negative or non-finite input to 0h", () => {
    expect(formatHours(-5)).toBe("0h");
    expect(formatHours(NaN)).toBe("0h");
  });
});

describe("clockShiftHours", () => {
  it("returns a negative shift westward (BKK -> DXB, +7 to +4)", () => {
    expect(
      clockShiftHours("2026-08-10T10:00:00Z", "Asia/Bangkok", "2026-08-10T14:00:00Z", "Asia/Dubai"),
    ).toBe(-3);
  });

  it("returns a positive shift eastward (DXB -> AKL, +4 to +12 in NZ winter)", () => {
    expect(
      clockShiftHours("2026-08-10T10:00:00Z", "Asia/Dubai", "2026-08-11T02:00:00Z", "Pacific/Auckland"),
    ).toBe(8);
  });

  it("returns 0 for a same-tz sector", () => {
    expect(
      clockShiftHours("2026-08-10T10:00:00Z", "Asia/Dubai", "2026-08-10T14:00:00Z", "Asia/Dubai"),
    ).toBe(0);
  });

  it("rounds a half-hour zone (Asia/Kathmandu, +5:45) sensibly - .75 of an hour rounds UP to +6", () => {
    expect(clockShiftHours("2026-08-10T00:00:00Z", "UTC", "2026-08-10T06:00:00Z", "Asia/Kathmandu")).toBe(6);
  });
});

describe("dayOffset", () => {
  it("returns 0 when departure and arrival fall on the same local calendar day", () => {
    // DXB dep 09:00 +4 = local Aug 10; arrival same local day
    expect(
      dayOffset(
        "2026-08-10T05:00:00Z", // 09:00 Dubai
        "2026-08-10T10:00:00Z", // e.g. 14:00 Dubai, same day
        "Asia/Dubai",
        "Asia/Dubai",
      ),
    ).toBe(0);
  });

  it("returns +1 for an overnight arrival landing the next local day", () => {
    // Dep Dubai 23:00 local (19:00Z) Aug 10 -> Arr London 01:00 local (01:00Z) Aug 11
    expect(
      dayOffset("2026-08-10T19:00:00Z", "2026-08-11T01:00:00Z", "Asia/Dubai", "Europe/London"),
    ).toBe(1);
  });

  it("returns +2 for a long-haul DXB->AKL crossing the date line, arriving two local days later", () => {
    // DXB dep 2026-08-10 02:35 local (+4) = 2026-08-09T22:35:00Z
    // AKL arr 2026-08-12 06:15 local (+12 in Aug, NZ winter) = 2026-08-11T18:15:00Z
    const depUtc = "2026-08-09T22:35:00Z"; // Dubai local: 2026-08-10 02:35
    const arrUtc = "2026-08-11T18:15:00Z"; // Auckland local: 2026-08-12 06:15
    expect(dayOffset(depUtc, arrUtc, "Asia/Dubai", "Pacific/Auckland")).toBe(2);
  });

  it("returns -0 normalized to 0 semantics never negative for same-day short-hop backward tz", () => {
    // Dep local day should never itself be treated as negative when arrival tz is behind
    expect(
      dayOffset(
        "2026-08-10T12:00:00Z", // Dubai 16:00, Aug 10
        "2026-08-10T13:00:00Z", // Sao Paulo 10:00, Aug 10
        "Asia/Dubai",
        "America/Sao_Paulo",
      ),
    ).toBe(0);
  });

  it("returns 0 for a same-month regression case (no over-correction)", () => {
    // Dep Dubai 09:00 local Aug 5, arr Dubai 14:00 local Aug 5 - same local day
    expect(
      dayOffset("2026-08-05T05:00:00Z", "2026-08-05T10:00:00Z", "Asia/Dubai", "Asia/Dubai"),
    ).toBe(0);
  });

  it("returns +1 across a month boundary (Jan 31 -> Feb 1)", () => {
    // Dep Dubai 23:00 local Jan 31 (19:00Z), arr Dubai 01:00 local Feb 1 (2026-02-01T01:00:00Z Dubai local... )
    expect(
      dayOffset("2026-01-31T19:00:00Z", "2026-02-01T01:00:00Z", "Asia/Dubai", "Asia/Dubai"),
    ).toBe(1);
  });

  it("returns +1 across a year boundary (Dec 31 -> Jan 1)", () => {
    expect(
      dayOffset("2026-12-31T19:00:00Z", "2027-01-01T01:00:00Z", "Asia/Dubai", "Asia/Dubai"),
    ).toBe(1);
  });

  it("returns +1 across a Feb 28 -> Mar 1 boundary in a non-leap year (2026)", () => {
    expect(
      dayOffset("2026-02-28T19:00:00Z", "2026-03-01T01:00:00Z", "Asia/Dubai", "Asia/Dubai"),
    ).toBe(1);
  });
});

describe("tripProgress", () => {
  // 3-day DXB->AKL->DXB trip, home base Asia/Dubai:
  // first dep 2026-08-10 02:15 Dubai local (2026-08-09T22:15:00Z)
  // last arr  2026-08-12 18:00 Dubai local (2026-08-12T14:00:00Z)
  // Local days spanned: Aug 10, Aug 11, Aug 12 -> totalDays = 3.
  const firstDepUtc = "2026-08-09T22:15:00Z";
  const lastArrUtc = "2026-08-12T14:00:00Z";

  it("returns null when now is before the first departure (fully future trip)", () => {
    const now = Date.parse("2026-08-09T20:00:00Z");
    expect(tripProgress(firstDepUtc, lastArrUtc, "Asia/Dubai", now)).toBeNull();
  });

  it("returns null when now is at/after the last arrival (fully past trip)", () => {
    const now = Date.parse("2026-08-12T14:00:00Z");
    expect(tripProgress(firstDepUtc, lastArrUtc, "Asia/Dubai", now)).toBeNull();
  });

  it("reports day 1 of N right after departure", () => {
    // 2026-08-09T23:00Z = Dubai local Aug 10 03:00 = trip's first local day
    const now = Date.parse("2026-08-09T23:00:00Z");
    expect(tripProgress(firstDepUtc, lastArrUtc, "Asia/Dubai", now)).toEqual({
      currentDay: 1,
      totalDays: 3,
    });
  });

  it("reports the middle day of a multi-day trip", () => {
    // 2026-08-11T10:00Z = Dubai local Aug 11 14:00 = trip's 2nd local day
    const now = Date.parse("2026-08-11T10:00:00Z");
    expect(tripProgress(firstDepUtc, lastArrUtc, "Asia/Dubai", now)).toEqual({
      currentDay: 2,
      totalDays: 3,
    });
  });

  it("reports the final day just before the last arrival", () => {
    const now = Date.parse("2026-08-12T13:00:00Z");
    expect(tripProgress(firstDepUtc, lastArrUtc, "Asia/Dubai", now)).toEqual({
      currentDay: 3,
      totalDays: 3,
    });
  });

  it("returns null for a single-leg same-day trip once it has landed", () => {
    const now = Date.parse("2026-08-10T14:00:00Z");
    expect(
      tripProgress("2026-08-10T02:15:00Z", "2026-08-10T13:35:00Z", "Asia/Dubai", now),
    ).toBeNull();
  });

  it("reports day 1 of 1 mid-flight on a single-leg same-local-day trip", () => {
    const now = Date.parse("2026-08-10T06:00:00Z");
    expect(
      tripProgress("2026-08-10T02:15:00Z", "2026-08-10T13:35:00Z", "Asia/Dubai", now),
    ).toEqual({ currentDay: 1, totalDays: 1 });
  });
});

describe("wallToUtc", () => {
  it("converts a wall-clock local time + IANA tz into the correct UTC ISO string", () => {
    // 2026-08-10 04:45 in Asia/Dubai (+04:00) = 2026-08-10T00:45:00.000Z
    expect(wallToUtc("2026-08-10T04:45:00", "Asia/Dubai")).toBe("2026-08-10T00:45:00.000Z");
  });

  it("handles the fractional Kathmandu offset (+05:45)", () => {
    expect(wallToUtc("2026-08-10T05:45:00", "Asia/Kathmandu")).toBe("2026-08-10T00:00:00.000Z");
  });

  it("resolves a skipped (nonexistent) wall time during spring-forward using the post-transition offset", () => {
    // Europe/London springs forward 2026-03-29 01:00 UTC (01:00 GMT -> 02:00 BST).
    // 01:30 local never occurs; disambiguate by treating it as BST (+1) => 00:30Z.
    expect(wallToUtc("2026-03-29T01:30:00", "Europe/London")).toBe("2026-03-29T00:30:00.000Z");
  });

  it("resolves an ambiguous (repeated) wall time during a fall-back transition using the earlier offset", () => {
    // Europe/London falls back 2026-10-25 01:00 UTC (BST +1 -> GMT +0); local 01:30 occurs twice
    // (01:30 BST at 00:30Z, then 01:30 GMT at 01:30Z). Earlier offset (+1, BST) wins.
    expect(wallToUtc("2026-10-25T01:30:00", "Europe/London")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("round-trips with formatLocal for an unambiguous stable-offset tz", () => {
    const utc = wallToUtc("2026-08-10T09:00:00", "America/Sao_Paulo");
    expect(formatLocal(utc, "America/Sao_Paulo")).toBe("09:00");
  });
});

describe("legDatesFromPicked", () => {
  it("keeps every leg on the picked date for a legit same-day connection (arr 12:00, dep 14:00)", () => {
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 0, depLocal: "09:00", arrLocal: "12:00" },
      { dayOffset: 0, depLocal: "14:00", arrLocal: "16:00" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-20"]);
  });

  it("carries a +1 arrival offset into the next leg's departure date (EK412 DXB->SYD->CHC, no over-roll)", () => {
    // Leg 0 DXB->SYD dayOffset 1 (arrives the day after departure at 06:00); leg 1
    // SYD->CHC departs 07:45, after leg 0's 06:00 arrival, so no extra safety-net roll -
    // dayOffset alone already correctly puts leg 1 on picked date + 1.
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 1, depLocal: "10:15", arrLocal: "06:00" },
      { dayOffset: 0, depLocal: "07:45", arrLocal: "12:55" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("rolls a leg's date forward a day when its stated dayOffset would depart it before the previous leg lands (regression: the pre-fix EK384 seed shape)", () => {
    // Synthetic fixture matching the original (incorrect) EK384/EK385 seed row shape that
    // shipped before this safety net existed: leg 0 dep 09:20 arr 18:35, dayOffset 0;
    // leg 1 stated dep 14:30, dayOffset 0 - naively that's the same day as leg 0's arrival,
    // but 14:30 is BEFORE 18:35, an impossible connection. The current seed has been
    // corrected to real EK384 times (which don't trigger this path - see the
    // "keeps every leg on the picked date" case above), but this regression test keeps
    // the safety net covered against any future bad seed/crowd data of this shape.
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 0, depLocal: "09:20", arrLocal: "18:35" },
      { dayOffset: 0, depLocal: "14:30", arrLocal: "18:20" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("matches the current (corrected) real EK384 seed: same-day BKK connection, no roll needed", () => {
    // Real EK384 DXB->BKK->HKG: leg 0 dep 02:50 arr BKK 12:30 (dayOffset 0); leg 1 dep
    // BKK 14:15 (after the 12:30 arrival - a legitimate ~1h45m ground time) arr HKG 18:15
    // (dayOffset 0). Both legs land on the picked date - the roll-forward net correctly
    // does NOT fire here since it's a real, physically possible connection.
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 0, depLocal: "02:50", arrLocal: "12:30" },
      { dayOffset: 0, depLocal: "14:15", arrLocal: "18:15" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-20"]);
  });

  it("matches the current (corrected) real EK385 seed: genuine cross-midnight BKK layover rolls leg 1 forward", () => {
    // Real EK385 HKG->BKK->DXB: leg 0 dep 21:30 arr BKK 23:45 (dayOffset 0); leg 1 dep
    // BKK 01:35 (a real overnight ground stop crossing local midnight) arr DXB 04:40
    // (dayOffset 0 for the leg itself). 01:35 < 23:45 as a same-day wall-clock comparison,
    // so the safety net correctly rolls leg 1 to the day after the picked date.
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 0, depLocal: "21:30", arrLocal: "23:45" },
      { dayOffset: 0, depLocal: "01:35", arrLocal: "04:40" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("accumulates offsets and rolls across 3+ legs", () => {
    const dates = legDatesFromPicked("2026-08-20", [
      { dayOffset: 1, depLocal: "22:00", arrLocal: "05:00" },
      { dayOffset: 1, depLocal: "10:00", arrLocal: "18:00" },
      { dayOffset: 0, depLocal: "20:00", arrLocal: "23:00" },
    ]);
    expect(dates).toEqual(["2026-08-20", "2026-08-21", "2026-08-22"]);
  });

  it("returns just the picked date for a single-leg flight", () => {
    expect(
      legDatesFromPicked("2026-08-20", [{ dayOffset: 0, depLocal: "09:00", arrLocal: "12:00" }]),
    ).toEqual(["2026-08-20"]);
  });

  it("handles a month/year boundary crossing", () => {
    const dates = legDatesFromPicked("2026-12-31", [
      { dayOffset: 1, depLocal: "10:15", arrLocal: "06:00" },
      { dayOffset: 0, depLocal: "07:45", arrLocal: "12:55" },
    ]);
    expect(dates).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("monthGrid", () => {
  it("returns 6 weeks of 7 days each", () => {
    const grid = monthGrid(2026, 8, "Asia/Dubai");
    expect(grid).toHaveLength(6);
    for (const week of grid) {
      expect(week).toHaveLength(7);
    }
  });

  it("starts weeks on Monday: Aug 2026 1st is a Saturday, so the first week has 5 lead-in days", () => {
    // 2026-08-01 is a Saturday -> Mon-start week is [Jul 27 .. Aug 2]
    const grid = monthGrid(2026, 8, "Asia/Dubai");
    const firstWeek = grid[0]!;
    expect(firstWeek.map((c) => c.iso)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(firstWeek.map((c) => c.inMonth)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(firstWeek.map((c) => c.day)).toEqual([27, 28, 29, 30, 31, 1, 2]);
  });

  it("marks trailing out-of-month days in the final week", () => {
    // Aug 2026 has 31 days, last day (Aug 31) is a Monday -> final week spans into September.
    const grid = monthGrid(2026, 8, "Asia/Dubai");
    const lastWeek = grid[grid.length - 1]!;
    expect(lastWeek[0]).toEqual({ iso: "2026-08-31", day: 31, inMonth: true });
    expect(lastWeek[1]).toEqual({ iso: "2026-09-01", day: 1, inMonth: false });
  });

  it("handles February in a non-leap year (2026, 28 days)", () => {
    // 2026-02-01 is a Sunday -> Mon-start first week leads in with Jan 26-31.
    const grid = monthGrid(2026, 2, "Asia/Dubai");
    const flat = grid.flat();
    const inMonthDays = flat.filter((c) => c.inMonth);
    expect(inMonthDays).toHaveLength(28);
    expect(inMonthDays[0]!.iso).toBe("2026-02-01");
    expect(inMonthDays[inMonthDays.length - 1]!.iso).toBe("2026-02-28");
  });

  it("handles a month where the 1st falls on Monday (no lead-in days)", () => {
    // 2026-06-01 is a Monday.
    const grid = monthGrid(2026, 6, "Asia/Dubai");
    const firstWeek = grid[0]!;
    expect(firstWeek[0]).toEqual({ iso: "2026-06-01", day: 1, inMonth: true });
  });

  it("produces ISO date strings independent of the tz's UTC offset direction", () => {
    // Same calendar month grid regardless of tz sign - grid is calendar-date arithmetic only.
    const dubai = monthGrid(2026, 8, "Asia/Dubai");
    const saoPaulo = monthGrid(2026, 8, "America/Sao_Paulo");
    expect(dubai).toEqual(saoPaulo);
  });
});

describe("tripDaysInMonth", () => {
  it("marks a single same-local-day trip as 'away' for its one day", () => {
    const trips: TripSpan[] = [
      { firstDepUtc: "2026-08-10T05:00:00Z", endUtc: "2026-08-10T10:00:00Z" },
    ];
    const map = tripDaysInMonth(trips, 2026, 8, "Asia/Dubai");
    expect(map.get("2026-08-10")).toBe("away");
    expect(map.size).toBe(1);
  });

  it("marks the first and last local day of a multi-day trip as 'partial' and the days between as 'away'", () => {
    // Home tz Asia/Dubai. First dep 2026-08-10 02:15 local (2026-08-09T22:15Z).
    // Last arr 2026-08-12 18:00 local (2026-08-12T14:00Z). Local days: Aug 10 (partial,
    // departs mid-day), Aug 11 (away, full day), Aug 12 (partial, arrives mid-day).
    const trips: TripSpan[] = [
      { firstDepUtc: "2026-08-09T22:15:00Z", endUtc: "2026-08-12T14:00:00Z" },
    ];
    const map = tripDaysInMonth(trips, 2026, 8, "Asia/Dubai");
    expect(map.get("2026-08-10")).toBe("partial");
    expect(map.get("2026-08-11")).toBe("away");
    expect(map.get("2026-08-12")).toBe("partial");
    expect(map.size).toBe(3);
  });

  it("only includes days that fall within the requested month/year", () => {
    // Trip spans Jul 31 -> Aug 2 in Asia/Dubai local; querying August should only include Aug 1-2.
    const trips: TripSpan[] = [
      { firstDepUtc: "2026-07-31T18:00:00Z", endUtc: "2026-08-02T10:00:00Z" }, // Jul 31 22:00, Aug 2 14:00 Dubai local
    ];
    const map = tripDaysInMonth(trips, 2026, 8, "Asia/Dubai");
    expect(map.has("2026-07-31")).toBe(false);
    expect(map.get("2026-08-01")).toBe("away");
    expect(map.get("2026-08-02")).toBe("partial");
  });

  it("merges multiple trips into one map, keyed by ISO date", () => {
    const trips: TripSpan[] = [
      { firstDepUtc: "2026-08-05T05:00:00Z", endUtc: "2026-08-05T10:00:00Z" },
      { firstDepUtc: "2026-08-20T05:00:00Z", endUtc: "2026-08-20T10:00:00Z" },
    ];
    const map = tripDaysInMonth(trips, 2026, 8, "Asia/Dubai");
    expect(map.get("2026-08-05")).toBe("away");
    expect(map.get("2026-08-20")).toBe("away");
    expect(map.size).toBe(2);
  });

  it("returns an empty map when no trips fall in the given month", () => {
    const trips: TripSpan[] = [
      { firstDepUtc: "2026-07-05T05:00:00Z", endUtc: "2026-07-05T10:00:00Z" },
    ];
    const map = tripDaysInMonth(trips, 2026, 8, "Asia/Dubai");
    expect(map.size).toBe(0);
  });
});

describe("localDateKey", () => {
  it("returns the local calendar date one day ahead of UTC when tz is far ahead (Pacific/Auckland)", () => {
    // 2026-08-10T21:00:00Z + 12h (NZ winter) = Aug 11 09:00 local.
    expect(localDateKey("2026-08-10T21:00:00Z", "Pacific/Auckland")).toBe("2026-08-11");
  });

  it("returns the local calendar date one day behind UTC when tz is behind (America/Sao_Paulo)", () => {
    // 2026-08-10T02:00:00Z - 3h = Aug 9 23:00 local.
    expect(localDateKey("2026-08-10T02:00:00Z", "America/Sao_Paulo")).toBe("2026-08-09");
  });

  it("matches the UTC calendar date when tz offset keeps the same local day", () => {
    expect(localDateKey("2026-08-10T12:00:00Z", "Asia/Dubai")).toBe("2026-08-10");
  });
});

describe("formatDuration", () => {
  it("keeps the minutes for a sector under a day", () => {
    expect(formatDuration("2026-08-18T05:40:00.000Z", "2026-08-18T12:25:00.000Z")).toBe("6h 45m");
  });

  it("drops the minutes when they are zero", () => {
    expect(formatDuration("2026-08-18T05:00:00.000Z", "2026-08-18T11:00:00.000Z")).toBe("6h");
  });

  it("reads in minutes under the hour", () => {
    expect(formatDuration("2026-08-18T05:00:00.000Z", "2026-08-18T05:45:00.000Z")).toBe("45m");
  });

  it("switches to days once a trip spans one, where minutes stop mattering", () => {
    expect(formatDuration("2026-08-15T06:00:00.000Z", "2026-08-18T02:20:00.000Z")).toBe("2d 20h");
  });

  it("returns empty for a non-positive or unparseable span rather than a bogus figure", () => {
    expect(formatDuration("2026-08-18T12:00:00.000Z", "2026-08-18T12:00:00.000Z")).toBe("");
    expect(formatDuration("not-a-date", "2026-08-18T12:00:00.000Z")).toBe("");
  });
});

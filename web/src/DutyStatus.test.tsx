import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Flight } from "@danyeowa/shared";
import { DutyStatus, dutyState } from "./DutyStatus";
import type { LayoverRest } from "./lib/layoverBrief";

/**
 * Her real 19–21 Sept Melbourne pairing, because the shape is the point: EK408 out and EK409
 * home are TWO SEPARATE TRIPS in her roster, not two legs of one. A component handed a single
 * trip's legs therefore cannot see the layover between them, which is why the rest arrives as
 * a prop.
 */
const leg = (over: Partial<Flight>): Flight => ({
  id: "f1",
  tripId: "t1",
  userId: "u1",
  flightNo: "EK408",
  origin: "DXB",
  dest: "MEL",
  depUtc: "2026-09-18T22:40:00.000Z",
  arrUtc: "2026-09-19T11:50:00.000Z",
  reportUtc: "2026-09-18T21:10:00.000Z",
  depTz: "Asia/Dubai",
  arrTz: "Australia/Melbourne",
  source: "manual",
  notes: null,
  legSeq: 0,
  operating: true,
  ...over,
});

const out = leg({});
const home = leg({
  id: "f2",
  tripId: "t2",
  flightNo: "EK409",
  origin: "MEL",
  dest: "DXB",
  depUtc: "2026-09-20T19:15:00.000Z",
  arrUtc: "2026-09-21T09:00:00.000Z",
  reportUtc: "2026-09-20T17:45:00.000Z",
  depTz: "Australia/Melbourne",
  arrTz: "Asia/Dubai",
});

/** What `layoverRests` produces for the gap between those two trips. */
const melRest: LayoverRest = {
  station: "MEL",
  inboundFlightNo: "EK408",
  outboundFlightNo: "EK409",
  arrUtc: out.arrUtc,
  arrTz: "Australia/Melbourne",
  nextReportUtc: home.reportUtc,
  nextDepUtc: home.depUtc,
  nextDepTz: "Australia/Melbourne",
  nextArrUtc: home.arrUtc,
  hours: 31.4,
  freeHours: 29.9,
  clockShift: 6,
};

const HOME_TZ = "Asia/Dubai";
const at = (iso: string) => new Date(iso);

describe("dutyState", () => {
  it("keeps a sector current until it LANDS, not until it reports", () => {
    // The rule CalendarHome uses to pick the next duty. These disagreed once and the card was
    // titled by one trip and coloured by another, so they are kept in step deliberately.
    const airborne = dutyState([out], Date.parse("2026-09-19T06:00:00.000Z"));
    expect(airborne?.kind).toBe("airborne");

    const justReported = dutyState([out], Date.parse("2026-09-18T21:30:00.000Z"));
    expect(justReported?.kind).toBe("upcoming");
  });

  it("reads the gap between two sectors OF ONE TRIP as down-route", () => {
    const twoLeg = [out, { ...home, tripId: "t1", legSeq: 1 }];
    const between = dutyState(twoLeg, Date.parse("2026-09-20T02:00:00.000Z"));
    expect(between).toMatchObject({ kind: "between", next: { flightNo: "EK409" } });
  });

  it("orders by legSeq, not by array order", () => {
    const shuffled = [{ ...home, tripId: "t1", legSeq: 1 }, { ...out, legSeq: 0 }];
    expect(dutyState(shuffled, Date.parse("2026-09-18T00:00:00.000Z"))).toMatchObject({
      kind: "upcoming",
      leg: { flightNo: "EK408" },
    });
  });
});

describe("DutyStatus", () => {
  it("leads HER card with a duration and HIS with the arrival date, for the same instant", () => {
    // The whole split, on one duty at one moment. Hers is time she can spend; his is a date he
    // can put in a diary.
    const now = at("2026-09-21T06:00:00.000Z"); // airborne on EK409

    const hers = render(<DutyStatus legs={[home]} homeTz={HOME_TZ} now={now} />);
    expect(screen.getByTestId("duty-status-hero")).toHaveTextContent("3h to go");
    hers.unmount();

    render(<DutyStatus legs={[home]} homeTz={HOME_TZ} now={now} readOnly />);
    // Spelled out with its weekday: EK409 departs on the 20th and lands on the 21st, and every
    // homecoming in her September does the same. A card that leads with the roster's own date
    // answers his only question wrongly.
    expect(screen.getByTestId("duty-status-hero")).toHaveTextContent("Mon 21 Sep");
    expect(screen.getByTestId("duty-status-hero")).toHaveTextContent("13:00");
  });

  it("shows the free window when she is down-route, from a rest that spans two trips", () => {
    // EK408 and EK409 are separate trips, so `legs` alone can never yield this state.
    render(
      <DutyStatus
        legs={[home]}
        homeTz={HOME_TZ}
        now={at("2026-09-20T02:00:00.000Z")}
        layoverRest={melRest}
      />,
    );

    expect(screen.getByTestId("duty-status-kicker")).toHaveTextContent("Down-route · MEL");
    // 20 Sept 02:00Z to the 17:45Z report.
    expect(screen.getByTestId("duty-status-hero")).toHaveTextContent("15h 45m free");
  });

  it("stops calling it down-route once report has passed", () => {
    render(
      <DutyStatus
        legs={[home]}
        homeTz={HOME_TZ}
        now={at("2026-09-20T18:30:00.000Z")}
        layoverRest={melRest}
      />,
    );
    expect(screen.getByTestId("duty-status-kicker")).not.toHaveTextContent("Down-route");
  });

  it("prints no clock that the timeline below it already prints", () => {
    // The DEP/ARR board was deleted for being the timeline twice. This block must not become it.
    render(<DutyStatus legs={[out]} homeTz={HOME_TZ} now={at("2026-09-16T08:00:00.000Z")} />);
    const block = screen.getByTestId("duty-status");
    expect(block).toHaveTextContent("Departs from DXB");
    expect(block.textContent).not.toMatch(/02:40/); // dep, Asia/Dubai
    expect(block.textContent).not.toMatch(/21:50/); // arr, Australia/Melbourne
  });

  it("scales the rail to the fraction elapsed, and never sets a width", () => {
    // Animating width hits layout every frame; this card mounts on every day tap.
    render(
      <DutyStatus
        legs={[home]}
        homeTz={HOME_TZ}
        now={at("2026-09-21T06:00:00.000Z")}
        layoverRest={null}
      />,
    );
    const fill = screen.getByTestId("duty-status-rail").firstElementChild as HTMLElement;
    // 19:15Z -> 09:00Z is 13h45m; 06:00Z is 10h45m in. 0.7818.
    expect(Number(fill.style.getPropertyValue("--ds-p"))).toBeCloseTo(0.7818, 3);
    expect(fill.style.width).toBe("");
  });
});

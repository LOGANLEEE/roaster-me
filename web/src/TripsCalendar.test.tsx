import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TripsCalendar from "./TripsCalendar";
import type { TripWithFlights } from "./api";

const now = new Date("2026-08-10T12:00:00.000Z"); // Aug 10, mid-month, Asia/Dubai local = Aug 10 16:00

const trip: TripWithFlights = {
  id: "trip-1",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    {
      id: "f1",
      tripId: "trip-1",
      userId: "u1",
      flightNo: "EK001",
      origin: "DXB",
      dest: "LHR",
      depUtc: "2026-08-15T05:00:00.000Z", // Aug 15 09:00 Dubai local
      arrUtc: "2026-08-15T10:00:00.000Z", // same local day
      reportUtc: "2026-08-15T03:30:00.000Z",
      depTz: "Asia/Dubai",
      arrTz: "Europe/London",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
  ],
};

/** EK247 out and EK248 back — two trips, one pairing, three layover days in Buenos Aires that
 * belong to neither and used to render exactly like a day at home. Aug 22 is a Saturday, so the
 * run crosses the week boundary between the 23rd and the 24th. */
function leg(
  id: string,
  tripId: string,
  origin: string,
  dest: string,
  dep: string,
  arr: string,
  legSeq: number,
) {
  return {
    id,
    tripId,
    userId: "u1",
    flightNo: "EK247",
    origin,
    dest,
    depUtc: dep,
    arrUtc: arr,
    reportUtc: dep,
    depTz: "Asia/Dubai",
    arrTz: "America/Argentina/Buenos_Aires",
    source: "manual" as const,
    notes: null,
    legSeq,
    operating: true,
  };
}

const outbound: TripWithFlights = {
  id: "ek247",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    leg(
      "o1",
      "ek247",
      "DXB",
      "GIG",
      "2026-08-22T02:30:00.000Z",
      "2026-08-22T15:10:00.000Z",
      0,
    ),
    leg(
      "o2",
      "ek247",
      "GIG",
      "EZE",
      "2026-08-22T17:00:00.000Z",
      "2026-08-22T20:15:00.000Z",
      1,
    ),
  ],
};

const inbound: TripWithFlights = {
  id: "ek248",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    leg(
      "i1",
      "ek248",
      "EZE",
      "GIG",
      "2026-08-26T22:00:00.000Z",
      "2026-08-27T01:10:00.000Z",
      0,
    ),
    leg(
      "i2",
      "ek248",
      "GIG",
      "DXB",
      "2026-08-27T03:00:00.000Z",
      "2026-08-27T21:40:00.000Z",
      1,
    ),
  ],
};

describe("TripsCalendar", () => {
  it("renders a weekday header row and the days of the current month", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-day-2026-08-10")).toBeInTheDocument();
  });

  it("marks the trip's day with an away marker", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[trip]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    const day = screen.getByTestId("calendar-day-2026-08-15");
    expect(day.className).toContain("bg-accent-soft");
    expect(screen.getByTestId("day-mark-2026-08-15")).toBeInTheDocument();
  });

  it("shows direction and station on the grid without opening the day", () => {
    // DXB -> AKL out on Aug 15, slip Aug 16-17, AKL -> DXB home on Aug 18.
    const pairing: TripWithFlights = {
      ...trip,
      id: "trip-2",
      flights: [
        {
          ...trip.flights[0]!,
          id: "f-out",
          dest: "AKL",
          depUtc: "2026-08-15T05:00:00.000Z",
          arrUtc: "2026-08-16T02:00:00.000Z",
          arrTz: "Pacific/Auckland",
        },
        {
          ...trip.flights[0]!,
          id: "f-home",
          origin: "AKL",
          dest: "DXB",
          depUtc: "2026-08-18T05:00:00.000Z",
          arrUtc: "2026-08-18T18:00:00.000Z",
          depTz: "Pacific/Auckland",
          legSeq: 1,
        },
      ],
    };

    render(
      <TripsCalendar
        now={now}
        trips={[pairing]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    expect(screen.getByTestId("day-mark-2026-08-15")).toHaveTextContent("↗AKL");
    expect(screen.getByTestId("day-mark-2026-08-16")).toHaveTextContent("·AKL");
    expect(screen.getByTestId("day-mark-2026-08-18")).toHaveTextContent("↙AKL");
  });

  it("shows a turnaround glyph for an out-and-back day", () => {
    const turnaround: TripWithFlights = {
      ...trip,
      id: "trip-3",
      flights: [
        {
          ...trip.flights[0]!,
          id: "f-out",
          dest: "BKK",
          depUtc: "2026-08-18T05:40:00.000Z",
          arrUtc: "2026-08-18T11:25:00.000Z",
        },
        {
          ...trip.flights[0]!,
          id: "f-back",
          origin: "BKK",
          dest: "DXB",
          depUtc: "2026-08-18T13:00:00.000Z",
          arrUtc: "2026-08-18T17:00:00.000Z",
          legSeq: 1,
        },
      ],
    };

    render(
      <TripsCalendar
        now={now}
        trips={[turnaround]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    expect(screen.getByTestId("day-mark-2026-08-18")).toHaveTextContent("⇄BKK");
  });

  it("calls onPickDay when tapping a day covered by a trip", async () => {
    const user = userEvent.setup();
    const onPickDay = vi.fn();
    render(
      <TripsCalendar
        now={now}
        trips={[trip]}
        homeTz="Asia/Dubai"
        onPickDay={onPickDay}
      />,
    );

    await user.click(screen.getByTestId("calendar-day-2026-08-15"));
    expect(onPickDay).toHaveBeenCalledWith("2026-08-15");
  });

  it("calls onPickDay when tapping a future day with no trip", async () => {
    const user = userEvent.setup();
    const onPickDay = vi.fn();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={onPickDay}
      />,
    );

    await user.click(screen.getByTestId("calendar-day-2026-08-20"));
    expect(onPickDay).toHaveBeenCalledWith("2026-08-20");
  });

  it("calls onPickDay when tapping today", async () => {
    const user = userEvent.setup();
    const onPickDay = vi.fn();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={onPickDay}
      />,
    );

    await user.click(screen.getByTestId("calendar-day-2026-08-10"));
    expect(onPickDay).toHaveBeenCalledWith("2026-08-10");
  });

  it("does not call onPickDay when tapping a past day with no trip", async () => {
    const user = userEvent.setup();
    const onPickDay = vi.fn();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={onPickDay}
      />,
    );

    await user.click(screen.getByTestId("calendar-day-2026-08-01"));
    expect(onPickDay).not.toHaveBeenCalled();
  });

  it("navigates to the next and previous month via chevrons", async () => {
    const user = userEvent.setup();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-next"));
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-prev"));
    await user.click(screen.getByTestId("calendar-prev"));
    expect(screen.getByText(/july 2026/i)).toBeInTheDocument();
  });

  it("marks the layover days between the outbound and the return", () => {
    // The whole point: she is in Buenos Aires on the 24th, 25th and 26th. Per-trip spans left
    // those blank, which made them look identical to the days she is at home.
    render(
      <TripsCalendar
        now={now}
        trips={[outbound, inbound]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    for (const iso of ["2026-08-24", "2026-08-25", "2026-08-26"]) {
      expect(screen.getByTestId(`calendar-day-${iso}`).className).toContain(
        "bg-accent-soft",
      );
      expect(screen.getByTestId(`day-mark-${iso}`)).toHaveTextContent("EZE");
    }
    // And a day she really is at home stays unmarked.
    expect(
      screen.getByTestId("calendar-day-2026-08-30").className,
    ).not.toContain("bg-accent-soft");
  });

  it("draws a run of away days as one band, not as separate boxes", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[outbound, inbound]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    const day = (iso: string) => screen.getByTestId(`calendar-day-${iso}`);

    // 24th opens the row; 25th and 26th sit inside it, so inner corners square off.
    expect(day("2026-08-25").className).toContain("rounded-none");
    expect(day("2026-08-26").className).toContain("rounded-none");
    // She boards the flight home at 03:00Z on the 27th and lands 01:40 on the 28th, Dubai time.
    // The 27th is the last day away and closes the band; the 28th is a morning at home.
    expect(day("2026-08-27").className).toContain("rounded-r-lg");
    expect(day("2026-08-28").className).not.toContain("bg-accent-soft");
    // A day with nothing on it is a plain rounded box.
    expect(day("2026-08-30").className).toContain("rounded-lg");
    expect(day("2026-08-30").className).not.toContain("rounded-none");

    // The 0.5rem grid gap is bridged, so the band has no seams between the days inside it.
    expect(day("2026-08-25").querySelector(".left-full")).not.toBeNull();
    // ...and is not bridged past the end of the run.
    expect(day("2026-08-27").querySelector(".left-full")).toBeNull();
  });

  it("breaks the band at the week boundary rather than running off the row", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[outbound, inbound]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    // Aug 23 is a Sunday, the last column. A band cannot cross a row, so it closes there and
    // reopens on Monday the 24th — and neither may bridge into the gap at the row's edge.
    expect(screen.getByTestId("calendar-day-2026-08-23").className).toContain(
      "rounded-r-lg",
    );
    expect(
      screen.getByTestId("calendar-day-2026-08-23").querySelector(".left-full"),
    ).toBeNull();
    expect(screen.getByTestId("calendar-day-2026-08-24").className).toContain(
      "rounded-l-lg",
    );
  });

  it("marks today on the number, in its own colour", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    const today = screen.getByTestId("calendar-day-2026-08-10");
    expect(today.querySelector(".bg-today")).not.toBeNull();
    // Not the accent: on this screen blue means duty, so today must not borrow it.
    expect(today.className).not.toContain("ring-accent");
  });

  it("keeps today readable when it is also the selected day", () => {
    // The old treatment gave both a ring in the same colour, one pixel apart, so a day that was
    // both looked exactly like a day that was only today. Marking the NUMBER and marking the
    // CELL are different surfaces, so both can be true at once and still be told apart.
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
        selectedIso="2026-08-10"
      />,
    );

    const cell = screen.getByTestId("calendar-day-2026-08-10");
    expect(cell.className).toContain("ring-accent");
    expect(cell.querySelector(".bg-today")).not.toBeNull();
  });

  it("marks a selected day on the cell, and only the selected day", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
        selectedIso="2026-08-20"
      />,
    );

    const selected = screen.getByTestId("calendar-day-2026-08-20");
    const today = screen.getByTestId("calendar-day-2026-08-10");
    expect(selected.className).toContain("ring-accent");
    expect(selected.querySelector(".bg-today")).toBeNull();
    expect(today.className).not.toContain("ring-accent");
    expect(today.querySelector(".bg-today")).not.toBeNull();
  });

  it("puts today's mark on the home-base LOCAL date, not the UTC date, when tz is ahead of UTC", () => {
    // 2026-08-10T21:00:00Z in Pacific/Auckland (+12 NZ winter) is local Aug 11 09:00 -
    // the today ring must land on Aug 11, not the UTC calendar date Aug 10.
    const nowAheadOfUtc = new Date("2026-08-10T21:00:00.000Z");
    render(
      <TripsCalendar
        now={nowAheadOfUtc}
        trips={[]}
        homeTz="Pacific/Auckland"
        onPickDay={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("calendar-day-2026-08-11").querySelector(".bg-today"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("calendar-day-2026-08-10").querySelector(".bg-today"),
    ).toBeNull();
  });

  // jsdom (as pulled in by this project) has no PointerEvent constructor, so
  // fireEvent.pointerDown/etc silently fall back to a bare Event with no clientX/clientY -
  // testing-library resolves the constructor via `window[EventType] || window.Event`, and
  // `window.PointerEvent` is undefined here. A MouseEvent carries the same clientX/clientY
  // fields the component actually reads, so dispatching one typed as "pointerdown" et al is
  // enough for React's synthetic pointer-event plugin to see real coordinates.
  function firePointer(
    el: Element,
    type: "pointerdown" | "pointermove" | "pointerup",
    clientX: number,
    clientY: number,
  ) {
    fireEvent(
      el,
      new MouseEvent(type, {
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  // Fires the pointerdown/move/up sequence a real drag or trackpad gesture produces, ending at
  // (dx, dy) relative to a (0, 0) start.
  function swipe(el: Element, dx: number, dy: number) {
    firePointer(el, "pointerdown", 0, 0);
    firePointer(el, "pointermove", dx, dy);
    firePointer(el, "pointerup", dx, dy);
  }

  it("changes to the next month on a horizontal swipe left past the threshold", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );
    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();

    swipe(screen.getByTestId("calendar-grid"), -60, 0);

    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();
  });

  it("changes to the previous month on a horizontal swipe right past the threshold", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    swipe(screen.getByTestId("calendar-grid"), 60, 0);

    expect(screen.getByText(/july 2026/i)).toBeInTheDocument();
  });

  it("ignores a mostly-vertical drag, even past the horizontal distance threshold", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    // 60px horizontal, but 80px vertical - not clearly horizontal (ratio requires
    // |dx| > |dy| * 1.5), so this is page-scroll intent, not a swipe.
    swipe(screen.getByTestId("calendar-grid"), 60, 80);

    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();
  });

  it("does not call onPickDay when a swipe ends over a day cell", () => {
    const onPickDay = vi.fn();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={onPickDay}
      />,
    );
    const day = screen.getByTestId("calendar-day-2026-08-20");

    swipe(day, -60, 0);
    fireEvent.click(day);

    expect(onPickDay).not.toHaveBeenCalled();
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();
  });

  it("still navigates via the ‹ › buttons after swipe support is added", async () => {
    const user = userEvent.setup();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("calendar-next"));
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-prev"));
    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();
  });

  // The carousel track — the element the transform is written to, straight to the DOM rather than
  // through React (a re-render per pointermove would put 126 day cells through React per frame).
  const trackOf = (el: Element) => el.firstElementChild as HTMLElement;

  it("settles the track back to centre once a swipe has committed the new month", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );
    const grid = screen.getByTestId("calendar-grid");

    swipe(grid, -60, 0);

    // Committed synchronously — the month must never wait on a CSS transition that jsdom, a
    // background tab, or reduced motion will not run.
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();
    expect(trackOf(grid).style.transform).toBe("translate3d(-100%, 0, 0)");
    expect(trackOf(grid).style.transition).toMatch(/transform 320ms/);
  });

  it("glides back to centre after a drag too short to change the month", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );
    const grid = screen.getByTestId("calendar-grid");

    swipe(grid, -30, 0);

    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();
    expect(trackOf(grid).style.transform).toBe("translate3d(-100%, 0, 0)");
    expect(trackOf(grid).style.transition).toMatch(/transform 320ms/);
  });

  it("renders both neighbouring months, inert, so a drag reveals real days", () => {
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );
    const panels = [
      ...trackOf(screen.getByTestId("calendar-grid")).children,
    ] as HTMLElement[];

    expect(panels).toHaveLength(3);
    // jsdom implements neither the `inert` IDL property nor its behaviour, so this asserts the
    // attribute only; that it actually takes the panel out of the a11y tree is verified in a real
    // engine by web/verify-swipe.mjs.
    expect(panels.map((p) => p.hasAttribute("inert"))).toEqual([
      true,
      false,
      true,
    ]);
    // Only the centre panel is addressable: neighbouring grids repeat each other's edge days, so
    // test ids on all three would collide (2026-08-31 would exist twice).
    expect(panels[0]!.querySelector("[data-testid]")).toBeNull();
  });

  it("animates the ‹ › buttons with the same settle as a swipe", async () => {
    const user = userEvent.setup();
    render(
      <TripsCalendar
        now={now}
        trips={[]}
        homeTz="Asia/Dubai"
        onPickDay={vi.fn()}
      />,
    );
    const track = trackOf(screen.getByTestId("calendar-grid"));

    await user.click(screen.getByTestId("calendar-next"));

    expect(screen.getByText(/september 2026/i)).toBeInTheDocument();
    expect(track.style.transition).toMatch(/transform 320ms/);
    expect(track.style.transform).toBe("translate3d(-100%, 0, 0)");
  });

  it("puts today's mark on the home-base LOCAL date, not the UTC date, when tz is behind UTC", () => {
    // 2026-08-10T02:00:00Z in America/Sao_Paulo (-3) is local Aug 9 23:00 - the today ring
    // must land on Aug 9, not the UTC calendar date Aug 10.
    const nowBehindUtc = new Date("2026-08-10T02:00:00.000Z");
    render(
      <TripsCalendar
        now={nowBehindUtc}
        trips={[]}
        homeTz="America/Sao_Paulo"
        onPickDay={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("calendar-day-2026-08-09").querySelector(".bg-today"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("calendar-day-2026-08-10").querySelector(".bg-today"),
    ).toBeNull();
  });
});

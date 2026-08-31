import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Airport } from "@danyeowa/shared";
import CalendarHome from "./CalendarHome";
import { confirmSchedule, createTrip, deleteTrip, getAirport, getCrew, getCrewTrips, getTrips, lookupSchedule } from "./api";
import type { TripWithFlights } from "./api";

vi.mock("./api", () => ({
  getTrips: vi.fn(),
  createTrip: vi.fn(),
  // Resolves null by default: the duty timeline (and its per-station useAirport lookups) now
  // renders unconditionally for any selected trip day, not just in the airport-resolution tests
  // below - every other test needs this to resolve to SOMETHING rather than leave the mock's
  // default `undefined` return crashing useAirport's `.then()` on it.
  getAirport: vi.fn().mockResolvedValue(null),
  lookupSchedule: vi.fn(),
  confirmSchedule: vi.fn(),
  deleteTrip: vi.fn(),
  // No crew by default — the badge row renders nothing, which is what every test below but
  // the crew ones expects to see above the calendar.
  getCrew: vi.fn().mockResolvedValue({ members: [], sent: [], received: [] }),
  getCrewTrips: vi.fn(),
}));

// AKL 2-leg trip fixture: DXB -> SIN -> AKL, "now" fixed well before the first report time.
const now = new Date("2026-08-10T00:00:00.000Z");

const aklTrip: TripWithFlights = {
  id: "trip-1",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    {
      id: "f1",
      tripId: "trip-1",
      userId: "u1",
      flightNo: "EK448",
      origin: "DXB",
      dest: "SIN",
      depUtc: "2026-08-11T02:15:00.000Z",
      arrUtc: "2026-08-11T13:35:00.000Z",
      reportUtc: "2026-08-11T00:45:00.000Z",
      depTz: "Asia/Dubai",
      arrTz: "Asia/Singapore",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
    {
      id: "f2",
      tripId: "trip-1",
      userId: "u1",
      flightNo: "EK449",
      origin: "SIN",
      dest: "AKL",
      depUtc: "2026-08-11T16:00:00.000Z",
      arrUtc: "2026-08-12T04:20:00.000Z",
      reportUtc: "2026-08-11T14:30:00.000Z",
      depTz: "Asia/Singapore",
      arrTz: "Pacific/Auckland",
      source: "manual",
      notes: null,
      legSeq: 1,
      operating: true,
    },
  ],
};

// A SECOND, separate duty on the same local day as aklTrip's first leg (2026-08-11 Asia/Dubai):
// an early turnaround that lands before EK448 even reports. Two trips, two report times — not
// legs of one, which is why the day card stacks them rather than merging.
const secondDutySameDay: TripWithFlights = {
  id: "trip-2",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    {
      id: "f9",
      tripId: "trip-2",
      userId: "u1",
      flightNo: "EK900",
      origin: "DXB",
      dest: "BAH",
      depUtc: "2026-08-10T22:00:00.000Z",
      arrUtc: "2026-08-10T23:10:00.000Z",
      reportUtc: "2026-08-10T20:30:00.000Z",
      depTz: "Asia/Dubai",
      arrTz: "Asia/Bahrain",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
  ],
};

// Mid-pairing: she is down-route, so the next duty DEPARTS an outstation. The JED turnaround
// sits earlier in the month and leaves home base at 06:55 Dubai — 02:55Z, which is still the
// previous day in Buenos Aires.
const midPairingRoster: TripWithFlights[] = [
  {
    id: "trip-eze",
    userId: "u1",
    label: null,
    createdAt: now.getTime(),
    flights: [
      {
        id: "eze1",
        tripId: "trip-eze",
        userId: "u1",
        flightNo: "EK247",
        origin: "EZE",
        dest: "GIG",
        depUtc: "2026-08-26T22:00:00.000Z",
        arrUtc: "2026-08-27T01:10:00.000Z",
        reportUtc: "2026-08-26T20:30:00.000Z",
        depTz: "America/Argentina/Buenos_Aires",
        arrTz: "America/Sao_Paulo",
        source: "manual",
        notes: null,
        legSeq: 0,
        operating: true,
      },
    ],
  },
  {
    id: "trip-jed",
    userId: "u1",
    label: null,
    createdAt: now.getTime(),
    flights: [
      {
        id: "jed1",
        tripId: "trip-jed",
        userId: "u1",
        flightNo: "EK805",
        origin: "DXB",
        dest: "JED",
        depUtc: "2026-08-19T02:55:00.000Z",
        arrUtc: "2026-08-19T05:45:00.000Z",
        reportUtc: "2026-08-19T01:25:00.000Z",
        depTz: "Asia/Dubai",
        arrTz: "Asia/Riyadh",
        source: "manual",
        notes: null,
        legSeq: 0,
        operating: true,
      },
    ],
  },
];

// A real turnaround: out of base and back the same local day, with a short stop at the
// outstation. DXB 09:00 -> BAH 09:10, back BAH 11:00 -> DXB 13:10 (all local).
const turnaroundTrip: TripWithFlights = {
  id: "trip-ta",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    {
      id: "ta1",
      tripId: "trip-ta",
      userId: "u1",
      flightNo: "EK837",
      origin: "DXB",
      dest: "BAH",
      depUtc: "2026-08-14T05:00:00.000Z",
      arrUtc: "2026-08-14T06:10:00.000Z",
      reportUtc: "2026-08-14T03:30:00.000Z",
      depTz: "Asia/Dubai",
      arrTz: "Asia/Bahrain",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
    {
      id: "ta2",
      tripId: "trip-ta",
      userId: "u1",
      flightNo: "EK838",
      origin: "BAH",
      dest: "DXB",
      depUtc: "2026-08-14T08:00:00.000Z",
      arrUtc: "2026-08-14T09:10:00.000Z",
      reportUtc: "2026-08-14T06:30:00.000Z",
      depTz: "Asia/Bahrain",
      arrTz: "Asia/Dubai",
      source: "manual",
      notes: null,
      legSeq: 1,
      operating: true,
    },
  ],
};

// 3-day DXB->AKL->DXB trip, home base Asia/Dubai (origin of the first leg).
// first dep 2026-08-10 02:15 Dubai local; last arr 2026-08-12 18:00 Dubai local.
const inProgressTrip: TripWithFlights = {
  id: "trip-2",
  userId: "u1",
  label: null,
  createdAt: Date.parse("2026-08-09T00:00:00.000Z"),
  flights: [
    {
      id: "g1",
      tripId: "trip-2",
      userId: "u1",
      flightNo: "EK448",
      origin: "DXB",
      dest: "AKL",
      depUtc: "2026-08-09T22:15:00.000Z",
      arrUtc: "2026-08-10T16:20:00.000Z",
      reportUtc: "2026-08-09T20:45:00.000Z",
      depTz: "Asia/Dubai",
      arrTz: "Pacific/Auckland",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
    {
      id: "g2",
      tripId: "trip-2",
      userId: "u1",
      flightNo: "EK449",
      origin: "AKL",
      dest: "DXB",
      depUtc: "2026-08-12T04:00:00.000Z",
      arrUtc: "2026-08-12T14:00:00.000Z",
      reportUtc: "2026-08-12T02:30:00.000Z",
      depTz: "Pacific/Auckland",
      arrTz: "Asia/Dubai",
      source: "manual",
      notes: null,
      legSeq: 1,
      operating: true,
    },
  ],
};

// Single-leg fixture with IATA codes not touched by any other test in this file — the
// (session-lived, module-scoped) airport lookup cache in lib/airports.ts persists across
// `it` blocks, so a test asserting the PRE-resolution fallback needs codes no earlier test
// has already resolved and cached.
const citySampleTrip: TripWithFlights = {
  id: "trip-city",
  userId: "u1",
  label: null,
  createdAt: now.getTime(),
  flights: [
    {
      id: "city-f1",
      tripId: "trip-city",
      userId: "u1",
      flightNo: "QF1",
      origin: "SYD",
      dest: "NRT",
      depUtc: "2026-08-11T02:15:00.000Z",
      arrUtc: "2026-08-11T13:35:00.000Z",
      reportUtc: "2026-08-11T00:45:00.000Z",
      depTz: "Australia/Sydney",
      arrTz: "Asia/Tokyo",
      source: "manual",
      notes: null,
      legSeq: 0,
      operating: true,
    },
  ],
};

describe("CalendarHome", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getTrips).mockClear();
  });

  it("renders the month calendar and a compact next-duty card", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);

    render(<CalendarHome now={now} />);

    // Calendar grid renders (chevrons + weekday row).
    expect(await screen.findByTestId("calendar-next")).toBeInTheDocument();
    expect(screen.getByText("Mon")).toBeInTheDocument();

    // Next-duty card: FULL route chain (every stop, not just endpoints) + flight/trip-length
    // muted line, then the timeline. The DEP/ARR board is gone — every row it had was the
    // timeline's own words a few lines below it.
    const card = screen.getByTestId("next-duty-card");
    expect(card).toHaveTextContent("DXB → SIN → AKL");
    expect(card).toHaveTextContent("EK448 · Tue 11 Aug · 2 days");
    expect(card).toHaveTextContent("06:15"); // dep: firstLeg.depUtc in Asia/Dubai
    expect(card).toHaveTextContent("16:20"); // arr: lastLeg.arrUtc in Pacific/Auckland
    // Each of those times is printed ONCE, by the timeline, not once there and once on a board.
    expect(card.textContent?.match(/06:15/g) ?? []).toHaveLength(1);
    expect(card.textContent?.match(/16:20/g) ?? []).toHaveLength(1);
    // The landing day is spelled out rather than left as a "+1" to add to a date in another
    // country — it moved onto the Lands row when the board went. Auckland is a calendar day
    // ahead of the Dubai departure of that sector.
    expect(card).toHaveTextContent("Lands · Wed 12");
    // Elapsed time survives only because this is a multi-leg pairing, where it means the whole
    // trip including ground time — something no per-leg airborne figure says.
    expect(card).toHaveTextContent("1d 2h total");
    // The preview carries the timeline too. It used to stop at the board rows, which is what
    // "day 22 renders without details" was: the home screen showed a route and three times,
    // and everything else was one tap away with nothing on screen saying so.
    expect(card).toHaveTextContent(/departs/i);
    expect(card).toHaveTextContent("11h 20m airborne");
    // "Leave home" was report minus a flat 55 minutes — no home, no distance, no traffic in
    // that number, and she already carries an app that gives her report and e-gate.
    expect(card).not.toHaveTextContent(/leave home/i);
    // Report is not printed at all. It headed the board AND was the timeline's second row —
    // the same time twice on one card — and the crew member reads it in her airline's own app
    // anyway. It is still stored, still drives the push alert, just not shown here.
    expect(card).not.toHaveTextContent(/report/i);
    expect(card).not.toHaveTextContent("04:45"); // firstLeg.reportUtc in Asia/Dubai
  });

  it("shows the calendar skeleton while trips are loading, then replaces it once they resolve", async () => {
    let resolveTrips!: (trips: TripWithFlights[]) => void;
    vi.mocked(getTrips).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTrips = resolve;
        }),
    );

    render(<CalendarHome now={now} />);

    expect(await screen.findByTestId("calendar-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/loading…/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-next")).not.toBeInTheDocument();

    resolveTrips([aklTrip]);
    expect(await screen.findByTestId("calendar-next")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-skeleton")).not.toBeInTheDocument();
  });

  it("marks a trip day on the grid", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);

    render(<CalendarHome now={now} />);

    const day = await screen.findByTestId("calendar-day-2026-08-11");
    expect(day.className).toContain("bg-accent-soft");
  });

  it("shows an empty state with an add-trip action that selects today and shows the inline add form", async () => {
    vi.mocked(getTrips).mockResolvedValue([]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument();
    const addButton = screen.getByRole("button", { name: /add your first/i });
    expect(addButton).toBeInTheDocument();

    await user.click(addButton);
    expect(await screen.findByTestId("flightno-input")).toBeInTheDocument();
  });

  it("single tap on an empty calendar day selects it and shows a no-duty detail card with the inline add-trip form", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);
    await screen.findByTestId("calendar-next");

    // now = 2026-08-10; pick a later day in the same month with no trip coverage.
    await user.click(screen.getByTestId("calendar-day-2026-08-20"));

    const detail = await screen.findByTestId("day-detail-card");
    expect(detail).toHaveTextContent(/no duty/i);
    // No "Add trip" button to press first - the flight-no input is right there, one tap in.
    expect(screen.getByTestId("flightno-input")).toBeInTheDocument();
    // Selecting a day replaces the next-duty card.
    expect(screen.queryByTestId("next-duty-card")).not.toBeInTheDocument();
  });

  it("single tap on a trip day selects it and shows a trip detail card with an Edit trip button", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

    const detail = await screen.findByTestId("day-detail-card");
    expect(detail).toHaveTextContent("DXB → SIN → AKL");
    expect(detail).toHaveTextContent("EK448");
    // Icon-only button now - identify by its aria-label, not text content.
    expect(screen.getByTestId("day-detail-action")).toHaveAttribute("aria-label", "Edit trip");
  });

  it("tapping the next-duty card selects that duty's day, showing its detail card in place", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("next-duty-card"));

    const detail = await screen.findByTestId("day-detail-card");
    expect(detail).toHaveTextContent("EK448");
    expect(screen.getByTestId("day-detail-action")).toHaveAttribute("aria-label", "Edit trip");
  });

  it("second tap on the already-selected trip day keeps its detail card up (trip days expand in place)", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("calendar-day-2026-08-11"));

    expect(screen.getByTestId("day-detail-card")).toHaveTextContent("EK448");
  });

  it("the detail card's action button expands a trip day in place (trip-legs-panel)", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");

    expect(screen.queryByTestId("trip-legs-panel")).not.toBeInTheDocument();
    const action = screen.getByTestId("day-detail-action");
    expect(action).toHaveAttribute("aria-expanded", "false");

    await user.click(action);

    expect(await screen.findByTestId("trip-legs-panel")).toBeInTheDocument();
    expect(action).toHaveAttribute("aria-expanded", "true");
    expect(action).toHaveAttribute("aria-label", "Hide flight details");
  });

  it("tapping a different day switches the selection", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("calendar-day-2026-08-20"));

    const detail = await screen.findByTestId("day-detail-card");
    expect(detail).toHaveTextContent(/no duty/i);
  });

  it("keeps the detail card up with no dismiss button, switching it as other days are tapped", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    expect(screen.queryByTestId("day-detail-clear")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("calendar-day-2026-08-20"));
    expect(await screen.findByTestId("day-detail-card")).toHaveTextContent(/no duty/i);
  });

  it("shows the active pairing progress card when a trip spans now, with correct day X of N", async () => {
    vi.mocked(getTrips).mockResolvedValue([inProgressTrip]);
    // Mid-trip: 2026-08-11T10:00:00Z is Aug 11 local in Asia/Dubai (home base), the 2nd of 3
    // local days spanned by the trip (first dep local day Aug 10, last arr local day Aug 12).
    const midTripNow = new Date("2026-08-11T10:00:00.000Z");

    render(<CalendarHome now={midTripNow} />);

    const card = await screen.findByTestId("pairing-progress-card");
    expect(card).toHaveTextContent(/trip.*3 days/i);
    const dayLabel = await screen.findByText("day 2 of 3");
    expect(dayLabel.className).toContain("num");
    expect(card).toHaveTextContent("DXB");
    expect(card).toHaveTextContent("AKL");
  });

  it("says '1 day', not '1 days', for a turnaround that starts and ends today", async () => {
    // A day trip is a real roster line, and the counter printed "Trip · 1 days" on it.
    // `now` sits between the first departure (05:00Z) and the second leg's report (06:30Z), so
    // the trip is in progress AND a duty is still upcoming — the card only renders for both.
    vi.mocked(getTrips).mockResolvedValue([turnaroundTrip]);

    render(<CalendarHome now={new Date("2026-08-14T06:00:00.000Z")} />);

    const card = await screen.findByTestId("pairing-progress-card");
    // No \b: textContent runs the next line straight on ("1 dayday 1 of 1"), so assert the
    // absence of the plural instead.
    expect(card).toHaveTextContent(/trip · 1 day(?!s)/i);
    expect(card).not.toHaveTextContent(/1 days/i);
  });

  it("does not show the pairing progress card for a fully future trip", async () => {
    vi.mocked(getTrips).mockResolvedValue([inProgressTrip]);
    // Genuinely before the trip's first departure (2026-08-09T22:15:00.000Z) - not the
    // module-level `now`, which is actually mid-trip for this fixture.
    const fullyFutureNow = new Date("2026-08-01T00:00:00.000Z");
    render(<CalendarHome now={fullyFutureNow} />);

    await screen.findByTestId("next-duty-card");
    expect(screen.queryByTestId("pairing-progress-card")).not.toBeInTheDocument();
  });

  it("selects today when openTodayToken changes and today is trip-free, showing the inline add form", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const { rerender } = render(<CalendarHome now={now} openTodayToken={0} />);
    await screen.findByTestId("next-duty-card");

    rerender(<CalendarHome now={now} openTodayToken={1} />);

    const detail = await screen.findByTestId("day-detail-card");
    expect(detail).toHaveTextContent(/no duty/i);
    expect(screen.getByTestId("flightno-input")).toBeInTheDocument();
  });

  it("selects TODAY even when today already has a duty (a day can hold more than one)", async () => {
    vi.mocked(getTrips).mockResolvedValue([inProgressTrip]);
    // now falls on inProgressTrip's away span (2026-08-09..2026-08-12 Asia/Dubai).
    const { rerender } = render(<CalendarHome now={new Date("2026-08-10T10:00:00.000Z")} openTodayToken={0} />);
    await screen.findByTestId("next-duty-card");

    rerender(<CalendarHome now={new Date("2026-08-10T10:00:00.000Z")} openTodayToken={1} />);

    // The + button used to walk forward to the first trip-free day, because a day that already
    // had a duty could not take another. Now that it can, skipping would send you to the wrong
    // date to add the second duty of the day you are looking at. So: today, duty and all — the
    // existing duty is shown, with the add-another affordance beneath it.
    const detail = await screen.findByTestId("day-detail");
    expect(detail).toHaveTextContent(/EK448/);
    expect(screen.getByTestId("add-another-duty")).toBeInTheDocument();
  });

  it("stacks a card per duty when a day holds more than one", async () => {
    // Two separate trips whose away spans both cover 2026-08-11.
    vi.mocked(getTrips).mockResolvedValue([aklTrip, secondDutySameDay]);
    const user = userEvent.setup();
    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

    const cards = await screen.findAllByTestId("day-detail-card");
    expect(cards).toHaveLength(2);
    // Each card owns its own delete control, so the two duties stay independently removable.
    expect(screen.getAllByTestId("delete-trip")).toHaveLength(2);
  });

  it("delete-trip -> confirm-delete on the day card deletes the trip and refetches", async () => {
    vi.mocked(getTrips).mockResolvedValueOnce([aklTrip]);
    vi.mocked(deleteTrip).mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");

    // Delete lives on the card header itself - no need to expand first.
    await user.click(screen.getByTestId("delete-trip"));
    expect(await screen.findByTestId("delete-dialog")).toBeInTheDocument();
    expect(screen.getByText(/delete this duty\?/i)).toBeInTheDocument();

    vi.mocked(getTrips).mockResolvedValueOnce([]);
    await user.click(screen.getByTestId("confirm-delete"));

    await waitFor(() => expect(deleteTrip).toHaveBeenCalledWith("trip-1"));
    // onChanged -> refetch: a second getTrips call beyond the initial render.
    await waitFor(() => expect(getTrips).toHaveBeenCalledTimes(2));
  });

  it("a delete failure from the day card shows an alert and keeps the confirm row open", async () => {
    vi.mocked(getTrips).mockResolvedValueOnce([aklTrip]);
    vi.mocked(deleteTrip).mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");

    await user.click(screen.getByTestId("delete-trip"));
    await user.click(screen.getByTestId("confirm-delete"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/network error/i);
    expect(screen.getByTestId("confirm-delete")).toBeInTheDocument();
  });

  // The lookup response shape a successful flight-code edit re-runs against.
  const EK449_LEGS = [
    {
      legSeq: 0,
      origin: "DXB",
      dest: "SIN",
      depLocal: "06:15",
      arrLocal: "17:35",
      dayOffset: 0,
      originTz: "Asia/Dubai",
      destTz: "Asia/Singapore",
      confirmCount: 1,
    },
  ];

  it("pencil enters edit mode with the flight-number field prefilled with the current flight number", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("day-detail-action"));

    expect(await screen.findByTestId("card-edit-flightno")).toHaveValue("448");
  });

  it("a successful edit save creates the replacement trip, deletes the original in that order, then refetches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getTrips).mockResolvedValueOnce([aklTrip]);
    vi.mocked(getTrips).mockResolvedValueOnce([]);
    vi.mocked(lookupSchedule).mockReset();
    vi.mocked(lookupSchedule).mockResolvedValue({ legs: EK449_LEGS });
    vi.mocked(createTrip).mockReset();
    vi.mocked(deleteTrip).mockReset();
    // The save fires a fire-and-forget confirmSchedule() per leg, chained with .catch() -
    // it must resolve to an actual promise or that chain throws before onSubmitted runs.
    vi.mocked(confirmSchedule).mockReset();
    vi.mocked(confirmSchedule).mockResolvedValue(undefined);
    const callOrder: string[] = [];
    vi.mocked(createTrip).mockImplementation(async () => {
      callOrder.push("create");
      return { ...aklTrip, id: "trip-new" };
    });
    vi.mocked(deleteTrip).mockImplementation(async () => {
      callOrder.push("delete");
    });

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("day-detail-action"));

    const input = await screen.findByTestId("card-edit-flightno");
    await user.clear(input);
    await user.type(input, "449");
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(screen.getByTestId("card-edit-save")).not.toBeDisabled());
    await user.click(screen.getByTestId("card-edit-save"));

    await waitFor(() => expect(deleteTrip).toHaveBeenCalledWith("trip-1"));
    expect(callOrder).toEqual(["create", "delete"]);
    // onSubmitted's own refetch (onChanged), on top of the initial mount fetch.
    await waitFor(() => expect(getTrips).toHaveBeenCalledTimes(2));
  });

  it("a failed create during an edit does not delete the original trip", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    vi.mocked(lookupSchedule).mockReset();
    vi.mocked(lookupSchedule).mockResolvedValue({ legs: EK449_LEGS });
    vi.mocked(createTrip).mockReset();
    vi.mocked(createTrip).mockRejectedValue(new Error("network error"));
    vi.mocked(deleteTrip).mockReset();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("day-detail-action"));

    const input = await screen.findByTestId("card-edit-flightno");
    await user.clear(input);
    await user.type(input, "449");
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(screen.getByTestId("card-edit-save")).not.toBeDisabled());
    await user.click(screen.getByTestId("card-edit-save"));

    await waitFor(() => expect(createTrip).toHaveBeenCalled());
    expect(deleteTrip).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/network error/i);
    // A failed create keeps edit mode open rather than discarding the in-progress edit.
    expect(screen.getByTestId("card-edit-flightno")).toBeInTheDocument();
  });

  it("cancel from edit mode leaves the trip untouched", async () => {
    vi.mocked(getTrips).mockResolvedValue([aklTrip]);
    vi.mocked(createTrip).mockReset();
    vi.mocked(deleteTrip).mockReset();
    const user = userEvent.setup();

    render(<CalendarHome now={now} />);

    await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
    await screen.findByTestId("day-detail-card");
    await user.click(screen.getByTestId("day-detail-action"));
    await screen.findByTestId("card-edit-flightno");

    await user.click(screen.getByTestId("card-edit-cancel"));

    expect(screen.queryByTestId("card-edit-flightno")).not.toBeInTheDocument();
    expect(createTrip).not.toHaveBeenCalled();
    expect(deleteTrip).not.toHaveBeenCalled();
    expect(screen.getByTestId("day-detail-card")).toHaveTextContent("EK448");
    expect(getTrips).toHaveBeenCalledTimes(1);
  });

  it("adding a trip inline on an empty day's card clears the form and flips the card to the trip view once the refetch resolves", async () => {
    // Trip landing on the SAME calendar cell (2026-08-20, Asia/Dubai local) the test taps -
    // stands in for whatever the (mocked) createTrip call actually saved, since only the
    // parent's own refetch (not createTrip's return value) drives the card switch. The add-trip
    // form lives directly on the day-detail card (no bottom sheet) - this exercises the
    // CalendarHome <-> AddTripForm wiring end to end, not AddTripForm's own internals (covered
    // by AddTripForm.test.tsx).
    const addedTrip: TripWithFlights = {
      id: "trip-new",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [
        {
          id: "new-f1",
          tripId: "trip-new",
          userId: "u1",
          flightNo: "EK449",
          origin: "DXB",
          dest: "SIN",
          depUtc: "2026-08-20T02:15:00.000Z",
          arrUtc: "2026-08-20T13:35:00.000Z",
          reportUtc: "2026-08-20T00:45:00.000Z",
          depTz: "Asia/Dubai",
          arrTz: "Asia/Singapore",
          source: "manual",
          notes: null,
          legSeq: 0,
          operating: true,
        },
      ],
    };
    let resolveSecondFetch!: (trips: TripWithFlights[]) => void;
    vi.mocked(getTrips)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );
    vi.mocked(lookupSchedule).mockResolvedValue({ legs: EK449_LEGS });
    vi.mocked(createTrip).mockResolvedValue(addedTrip);
    vi.mocked(confirmSchedule).mockResolvedValue(undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CalendarHome now={now} />);
    await user.click(await screen.findByTestId("calendar-day-2026-08-20"));

    const flightInput = await screen.findByTestId("flightno-input");
    await user.type(flightInput, "449");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("autofill-card");

    await user.click(screen.getByRole("button", { name: /add to roster/i }));

    // The parent's refetch is still pending (deliberately unresolved above) - the day-detail
    // card must already be showing a FRESH, blank form rather than the just-submitted preview.
    await waitFor(() => expect(screen.getByTestId("flightno-input")).toHaveValue(""));
    expect(screen.queryByTestId("autofill-card")).not.toBeInTheDocument();

    // Once the refetch resolves with the new trip, the card flips over to the trip view.
    resolveSecondFetch([addedTrip]);
    await waitFor(() => expect(screen.getByTestId("delete-trip")).toBeInTheDocument());
  });

  describe("duty timeline", () => {
    it("shows the full duty timeline inline as soon as a trip day is selected, no scroll or extra tap needed", async () => {
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getAirport).mockResolvedValue(null);
      const user = userEvent.setup();

      render(<CalendarHome now={now} />);
      expect(screen.queryByTestId("duty-timeline")).not.toBeInTheDocument();

      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

      const timeline = await screen.findByTestId("duty-timeline");
      expect(timeline).not.toHaveTextContent("Leave home");
      expect(timeline).not.toHaveTextContent("03:50"); // the old report-minus-55m row
      expect(timeline).not.toHaveTextContent("Report");
      expect(timeline).not.toHaveTextContent("04:45"); // firstLeg.reportUtc in Asia/Dubai
      expect(timeline).toHaveTextContent("Departs");
      // The origin station line moved here from the deleted report row, so the card still
      // names where she leaves from rather than only its IATA code in the headline.
      expect(timeline).toHaveTextContent("DXB");
      expect(timeline).toHaveTextContent("06:15"); // firstLeg.depUtc in Asia/Dubai
      expect(timeline).toHaveTextContent("11h 20m airborne"); // leg 0: 02:15Z -> 13:35Z
      expect(timeline).toHaveTextContent("Lands");
      expect(timeline).toHaveTextContent("21:35"); // leg 0 arrUtc in Asia/Singapore
      // No board above the timeline any more, and report appears nowhere on the card.
      const detail = screen.getByTestId("day-detail-card");
      expect(detail).not.toHaveTextContent(/report/i);
      // "DEP"/"ARR" as standalone board labels are gone; "Departs"/"Lands" are the timeline's.
      expect(detail.textContent).not.toMatch(/\bDEP\b/);
      expect(detail.textContent).not.toMatch(/\bARR\b/);
    });

    it("remounts the timeline when another day of the SAME trip is picked, so the stagger replays", async () => {
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getAirport).mockResolvedValue(null);
      const user = userEvent.setup();

      render(<CalendarHome now={now} />);

      // A CSS entry animation fires once per ELEMENT. A pairing renders the same trip (same
      // `trip.id`, so the same card) on every day it spans, so without a per-day key React
      // kept the very same rows and tapping the second day animated nothing at all.
      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
      const first = await screen.findByTestId("duty-timeline");

      await user.click(await screen.findByTestId("calendar-day-2026-08-12"));
      const second = await screen.findByTestId("duty-timeline");

      expect(second).not.toBe(first);
      // Same duty either way — this is a remount, not a different trip.
      expect(second).toHaveTextContent("Departs");
      expect(second).toHaveTextContent("11h 20m airborne");
    });

    it("shows a layover row between legs for a multi-leg trip, with a Departs/Lands pair per leg", async () => {
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getAirport).mockResolvedValue(null);
      const user = userEvent.setup();

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

      const timeline = await screen.findByTestId("duty-timeline");
      // layoverHours(leg0.arrUtc 13:35Z, leg1.depUtc 16:00Z) = ~2.4h, rounded to 2h by formatHours.
      // Under MIN_LAYOVER_FREE_HOURS, so it is TRANSIT, not a layover — she does not leave the
      // airport at Singapore on the way to Auckland, and calling it a layover put a city guide
      // and "5m free until report" on a stop she never walks out of.
      expect(timeline).toHaveTextContent("Transit · SIN");
      expect(timeline).not.toHaveTextContent("Layover · SIN");
      expect(timeline).toHaveTextContent("2h");
      expect(screen.getAllByText("Departs")).toHaveLength(2);
      // One of the two carries the landing date ("Lands · Wed 12"): this pairing leaves Dubai on
      // the Tuesday and is down in Auckland on the Wednesday.
      expect(screen.getAllByText(/^Lands( · .+)?$/)).toHaveLength(2);
    });

    it("keys the grid to HOME BASE, not to wherever the next duty happens to depart", async () => {
      // The grid used to take nextDuty.depTz. Mid-pairing that is an outstation: with the next
      // duty leaving Buenos Aires (UTC-3), EK805's 06:55 Dubai departure keyed to the day
      // BEFORE, so the 19th held no departure and fell through to the layover glyph — a grid
      // saying "layover at JED" on a day whose own card said "DXB → JED, departs 06:55".
      vi.mocked(getTrips).mockResolvedValue(midPairingRoster);
      // `now` has to sit AFTER the JED turnaround, so the next duty is the one leaving Buenos
      // Aires. With the module-level `now` (10 Aug) the next duty is the JED leg itself, whose
      // depTz IS home base — the two zones coincide and the bug cannot show.
      render(<CalendarHome now={new Date("2026-08-23T10:00:00.000Z")} />);

      const nineteenth = await screen.findByTestId("calendar-day-2026-08-19");
      expect(nineteenth).toHaveAttribute("aria-label", expect.stringContaining("outbound to JED"));
      expect(screen.getByTestId("calendar-day-2026-08-18")).not.toHaveAttribute(
        "aria-label",
        expect.stringContaining("JED"),
      );
    });

    it("names a turnaround, and calls its ground stop transit rather than a layover", async () => {
      vi.mocked(getTrips).mockResolvedValue([turnaroundTrip]);
      vi.mocked(getAirport).mockResolvedValue(null);
      const user = userEvent.setup();

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("calendar-day-2026-08-14"));

      const card = await screen.findByTestId("day-detail-card");
      expect(card).toHaveTextContent("DXB → BAH → DXB");
      expect(card).toHaveTextContent("turnaround");
      // 1h50m on the ground — she does not leave the airport, so no layover and no rest panel.
      expect(await screen.findByTestId("duty-timeline")).toHaveTextContent("Transit · BAH");
      expect(screen.queryByTestId("layover-brief")).not.toBeInTheDocument();
    });

    it("shows the bare IATA code until getAirport resolves, then the resolved city, without blocking the timeline's first paint", async () => {
      vi.mocked(getTrips).mockResolvedValue([citySampleTrip]);
      const resolvers = new Map<string, (airport: Airport | null) => void>();
      vi.mocked(getAirport).mockImplementation(
        (iata: string) =>
          new Promise((resolve) => {
            resolvers.set(iata, resolve);
          }),
      );
      const user = userEvent.setup();

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

      // Renders immediately with the bare code - never blocks on the airport fetch.
      const timeline = await screen.findByTestId("duty-timeline");
      expect(timeline).toHaveTextContent("SYD");
      expect(timeline).not.toHaveTextContent("Sydney");

      resolvers.get("SYD")!({ iata: "SYD", city: "Sydney", name: "Sydney Kingsford Smith", tz: "Australia/Sydney" });
      expect(await screen.findByText(/Sydney/)).toBeInTheDocument();
      // NRT (the Lands row, further down) hasn't resolved yet - still the bare code, and a
      // failed/pending lookup for it never breaks the rest of the card.
      expect(timeline).toHaveTextContent("NRT");
    });
  });

  // --- Crew: reading a paired member's roster. Read-only is enforced by the API (no write route
  // takes a user id); these cover the UI half — the switch, and keeping controls that would
  // always fail off the screen.
  describe("crew rosters", () => {
    const crewMember = { userId: "u-fo", email: "fo@example.com", name: "Sam Reyes", inviteId: "inv-1" };
    const crewTrip: TripWithFlights = {
      ...citySampleTrip,
      id: "trip-crew",
      userId: "u-fo",
      flights: [{ ...citySampleTrip.flights[0]!, id: "crew-f1", tripId: "trip-crew", userId: "u-fo" }],
    };

    it("renders no badge row at all when you have no crew", async () => {
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);

      render(<CalendarHome now={now} />);

      expect(await screen.findByTestId("next-duty-card")).toBeInTheDocument();
      expect(screen.queryByTestId("crew-badges")).not.toBeInTheDocument();
    });

    it("switches to a crew member's roster and back, fetching each from its own route", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      render(<CalendarHome now={now} />);

      await user.click(await screen.findByTestId("crew-badge-u-fo"));

      expect(getCrewTrips).toHaveBeenCalledWith("u-fo");
      // Their duty, not yours: the fixture's SYD leg, and none of your own AKL trip.
      const card = await screen.findByTestId("next-duty-card");
      expect(card).toHaveTextContent("SYD → NRT");
      expect(card).not.toHaveTextContent("AKL");
      expect(screen.getByTestId("crew-badge-u-fo")).toHaveAttribute("aria-pressed", "true");

      vi.mocked(getTrips).mockClear();
      await user.click(screen.getByTestId("crew-badge-self"));

      expect(getTrips).toHaveBeenCalled();
      expect(await screen.findByTestId("next-duty-card")).toHaveTextContent("DXB → SIN → AKL");
    });

    it("offers no edit or delete on a crew member's trip day", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([]);
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));
      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));

      expect(await screen.findByTestId("day-detail-card")).toBeInTheDocument();
      expect(screen.queryByTestId("day-detail-action")).not.toBeInTheDocument();
      expect(screen.queryByTestId("delete-trip")).not.toBeInTheDocument();
    });

    it("offers no add form on an empty day of a crew member's roster", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([]);
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));
      await user.click(await screen.findByTestId("calendar-day-2026-08-20"));

      expect(await screen.findByTestId("day-detail-card")).toHaveTextContent(/no duty/i);
      expect(screen.queryByTestId("flightno-input")).not.toBeInTheDocument();
    });

    // The no-upcoming-duty branch renders its own calendar and its own detail card, and is the
    // one that has regressed repeatedly in this file. A crew member with nothing ahead of them
    // lands here, so read-only has to hold on this path too — the first mutation test of the
    // other branch passed while this one was wired wrong.
    it("stays read-only on a crew roster with nothing upcoming", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getCrewTrips).mockResolvedValue([]);

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));

      // No "add your first trip" CTA on someone else's empty roster.
      expect(await screen.findByText(/nothing on this roster yet/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add your first trip/i })).not.toBeInTheDocument();

      await user.click(screen.getByTestId("calendar-day-2026-08-20"));
      expect(await screen.findByTestId("day-detail-card")).toHaveTextContent(/no duty/i);
      expect(screen.queryByTestId("flightno-input")).not.toBeInTheDocument();
    });

    // Three failure modes an adversarial review surfaced, all invisible on the happy path.
    it("ignores a slow own-roster response that lands after you switched to a crew member", async () => {
      const user = userEvent.setup();
      let resolveOwn!: (trips: TripWithFlights[]) => void;
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockImplementation(() => new Promise((resolve) => (resolveOwn = resolve)));
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));
      expect(await screen.findByTestId("next-duty-card")).toHaveTextContent("SYD → NRT");

      // The mount's own-roster fetch finally answers — under their badge. It must be dropped.
      resolveOwn([aklTrip]);
      await waitFor(() => expect(screen.getByTestId("crew-badge-u-fo")).toHaveAttribute("aria-pressed", "true"));
      expect(screen.getByTestId("next-duty-card")).toHaveTextContent("SYD → NRT");
    });

    it("falls back to your own roster when a pairing is revoked while you're reading it", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew)
        .mockResolvedValueOnce({ members: [crewMember], sent: [], received: [] })
        .mockResolvedValue({ members: [], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      // They revoked between the badge rendering and the tap: the crew read 404s from here on.
      vi.mocked(getCrewTrips).mockRejectedValue(new Error("Failed to load crew roster"));

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));

      // Not stuck on the skeleton: your own roster is back, and the stale badge is gone.
      expect(await screen.findByTestId("next-duty-card")).toHaveTextContent("DXB → SIN → AKL");
      await waitFor(() => expect(screen.queryByTestId("crew-badges")).not.toBeInTheDocument());
    });

    it("sends the tab bar's + back to your own roster instead of no-opping", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      const { rerender } = render(<CalendarHome now={now} openTodayToken={0} />);
      await user.click(await screen.findByTestId("crew-badge-u-fo"));
      expect(await screen.findByTestId("next-duty-card")).toHaveTextContent("SYD → NRT");

      // + means "add a trip", which only exists on your own roster.
      rerender(<CalendarHome now={now} openTodayToken={1} />);

      await waitFor(() => expect(screen.getByTestId("crew-badge-self")).toHaveAttribute("aria-pressed", "true"));
      expect(await screen.findByTestId("next-duty-card")).toHaveTextContent("DXB → SIN → AKL");
    });

    it("drops the selected day when switching rosters, so nobody's day carries over", async () => {
      const user = userEvent.setup();
      vi.mocked(getCrew).mockResolvedValue({ members: [crewMember], sent: [], received: [] });
      vi.mocked(getTrips).mockResolvedValue([aklTrip]);
      vi.mocked(getCrewTrips).mockResolvedValue([crewTrip]);

      render(<CalendarHome now={now} />);
      await user.click(await screen.findByTestId("calendar-day-2026-08-11"));
      expect(await screen.findByTestId("day-detail-card")).toBeInTheDocument();

      await user.click(screen.getByTestId("crew-badge-u-fo"));

      await waitFor(() => expect(screen.queryByTestId("day-detail-card")).not.toBeInTheDocument());
    });
  });
});

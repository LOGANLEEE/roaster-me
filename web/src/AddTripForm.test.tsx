import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddTripForm from "./AddTripForm";
import type { Airport } from "@danyeowa/shared";
import { confirmSchedule, createTrip, getAirport, lookupSchedule } from "./api";

vi.mock("./api", () => ({
  createTrip: vi.fn(),
  getAirport: vi.fn(),
  lookupSchedule: vi.fn(),
  confirmSchedule: vi.fn(),
}));

describe("AddTripForm", () => {
  beforeEach(() => {
    vi.mocked(createTrip).mockReset();
    vi.mocked(getAirport).mockReset();
    vi.mocked(lookupSchedule).mockReset();
    vi.mocked(confirmSchedule).mockReset();
    vi.mocked(confirmSchedule).mockResolvedValue(undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // EK205 is DXB->MXP->JFK and the crew can change at Milan, so the crew member may finish
  // before the aircraft does. Picking the first destination must mark the later sector as the
  // aircraft's onward routing — not drop it, and not leave it counting as her landing.
  it("multi-sector: picking an earlier final destination marks the later legs not-operating", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue({
      legs: [
        {
          legSeq: 0,
          origin: "DXB",
          dest: "MXP",
          depLocal: "09:25",
          arrLocal: "14:10",
          dayOffset: 0,
          originTz: "Asia/Dubai",
          destTz: "Europe/Rome",
          confirmCount: 2,
        },
        {
          legSeq: 1,
          origin: "MXP",
          dest: "JFK",
          depLocal: "16:10",
          arrLocal: "18:55",
          dayOffset: 0,
          originTz: "Europe/Rome",
          destTz: "America/New_York",
          confirmCount: 2,
        },
      ],
    });
    vi.mocked(createTrip).mockResolvedValue({
      id: "trip-205",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [],
    });

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "205");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("autofill-card");

    // Both destinations offered; the last is the default, so no note yet.
    await screen.findByTestId("final-destination");
    expect(screen.queryByTestId("continuation-note")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("final-dest-MXP"));
    expect(screen.getByTestId("continuation-note")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add to roster/i }));
    await waitFor(() => expect(createTrip).toHaveBeenCalled());

    const payload = vi.mocked(createTrip).mock.calls[0]?.[0];
    expect(payload!.legs).toHaveLength(2);
    expect(payload!.legs[0]).toMatchObject({ dest: "MXP", operating: true });
    expect(payload!.legs[1]).toMatchObject({ dest: "JFK", operating: false });

    // Only the sector she actually flew is reported back to the crowd-sourced schedule layer —
    // she cannot vouch for times on a leg she was not on.
    expect(confirmSchedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmSchedule).mock.calls[0]?.[0]).toMatchObject({
      dest: "MXP",
    });
  });

  // The other end of the same question, and the one that decides what the picked date MEANS.
  // EK248 is EZE->GIG->DXB with a day offset on both legs. A crew member joining at Rio dates
  // her duty by the Rio departure, so "26 Aug" must put GIG on the 26th and the EZE sector the
  // aircraft flew to reach her on the 25th. Read as leg 0's date it landed her in Dubai on the
  // 28th, and the calendar told the family she was home a day late.
  it("multi-sector: boarding partway re-dates the routing around the sector she actually flies", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue({
      legs: [
        {
          legSeq: 0,
          origin: "EZE",
          dest: "GIG",
          depLocal: "22:25",
          arrLocal: "01:10",
          dayOffset: 1,
          originTz: "America/Argentina/Buenos_Aires",
          destTz: "America/Sao_Paulo",
          confirmCount: 2,
        },
        {
          legSeq: 1,
          origin: "GIG",
          dest: "DXB",
          depLocal: "03:05",
          arrLocal: "00:30",
          dayOffset: 1,
          originTz: "America/Sao_Paulo",
          destTz: "Asia/Dubai",
          confirmCount: 2,
        },
      ],
    });
    vi.mocked(createTrip).mockResolvedValue({
      id: "trip-248",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [],
    });

    render(
      <AddTripForm isoDate="2026-08-26" homeTz="Asia/Dubai" onSubmitted={vi.fn()} />,
    );

    await user.type(screen.getByTestId("flightno-input"), "248");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("autofill-card");

    // Leg 0 is the default, so nothing is claimed about the date yet.
    await screen.findByTestId("boarding-point");
    expect(screen.queryByTestId("boarding-note")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("boarding-GIG"));
    expect(screen.getByTestId("boarding-note")).toHaveTextContent(/GIG departure/);

    await user.click(screen.getByRole("button", { name: /add to roster/i }));
    await waitFor(() => expect(createTrip).toHaveBeenCalled());

    const payload = vi.mocked(createTrip).mock.calls[0]?.[0];
    expect(payload!.legs).toHaveLength(2);
    // Buenos Aires and Rio are both UTC-3; Dubai is UTC+4.
    expect(payload!.legs[0]).toMatchObject({
      origin: "EZE",
      operating: false,
      depUtc: "2026-08-26T01:25:00.000Z", // 25 Aug 22:25 local — before she got on
    });
    expect(payload!.legs[1]).toMatchObject({
      origin: "GIG",
      operating: true,
      depUtc: "2026-08-26T06:05:00.000Z", // 26 Aug 03:05 local — the date she was given
      arrUtc: "2026-08-26T20:30:00.000Z", // 27 Aug 00:30 Dubai — the morning she got home
    });

    // She can vouch for the sector she worked and nothing else.
    expect(confirmSchedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmSchedule).mock.calls[0]?.[0]).toMatchObject({ origin: "GIG" });
  });

  // Times alone never say WHICH DAY they fall on, and a multi-leg flight walks the date
  // forward — picking a boarding point re-anchors the whole routing (see the test above), and
  // that shift was invisible on screen. Same EK248 fixture: assert the per-leg dates the
  // preview now shows, and that they move when the boarding point changes.
  it("preview: each leg shows its resolved date, and it shifts when boarding point changes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue({
      legs: [
        {
          legSeq: 0,
          origin: "EZE",
          dest: "GIG",
          depLocal: "22:25",
          arrLocal: "01:10",
          dayOffset: 1,
          originTz: "America/Argentina/Buenos_Aires",
          destTz: "America/Sao_Paulo",
          confirmCount: 2,
        },
        {
          legSeq: 1,
          origin: "GIG",
          dest: "DXB",
          depLocal: "03:05",
          arrLocal: "00:30",
          dayOffset: 1,
          originTz: "America/Sao_Paulo",
          destTz: "Asia/Dubai",
          confirmCount: 2,
        },
      ],
    });

    render(
      <AddTripForm isoDate="2026-08-26" homeTz="Asia/Dubai" onSubmitted={vi.fn()} />,
    );

    await user.type(screen.getByTestId("flightno-input"), "248");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("autofill-card");

    // Default boarding is leg 0 (EZE): EZE departs the 26th and lands GIG the 27th; GIG
    // departs the 27th and lands DXB the 28th.
    let depDates = screen.getAllByTestId("autofill-dep-date");
    let arrDates = screen.getAllByTestId("autofill-arr-date");
    expect(depDates.map((el) => el.textContent)).toEqual(["Wed 26 Aug", "Thu 27 Aug"]);
    expect(arrDates.map((el) => el.textContent)).toEqual(["Thu 27 Aug", "Fri 28 Aug"]);

    // Boarding at GIG re-anchors the 26th onto the GIG departure: EZE slides back to the
    // 25th, and GIG->DXB now lands the 27th, not the 28th.
    await user.click(screen.getByTestId("boarding-GIG"));

    depDates = screen.getAllByTestId("autofill-dep-date");
    arrDates = screen.getAllByTestId("autofill-arr-date");
    expect(depDates.map((el) => el.textContent)).toEqual(["Tue 25 Aug", "Wed 26 Aug"]);
    expect(arrDates.map((el) => el.textContent)).toEqual(["Wed 26 Aug", "Thu 27 Aug"]);
  });

  it("add flow: happy path posts the same UTC payload as the original stepper, then fires confirmSchedule and onSubmitted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue({
      legs: [
        {
          legSeq: 0,
          origin: "DXB",
          dest: "LHR",
          depLocal: "09:15",
          arrLocal: "13:35",
          dayOffset: 0,
          originTz: "Asia/Dubai",
          destTz: "Europe/London",
          confirmCount: 3,
        },
      ],
    });
    vi.mocked(createTrip).mockResolvedValue({
      id: "trip-1",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [
        {
          id: "new-f1",
          tripId: "trip-1",
          userId: "u1",
          flightNo: "EK412",
          origin: "DXB",
          dest: "LHR",
          depUtc: "2026-08-20T05:15:00.000Z",
          arrUtc: "2026-08-20T12:35:00.000Z",
          reportUtc: "2026-08-20T03:45:00.000Z",
          depTz: "Asia/Dubai",
          arrTz: "Europe/London",
          source: "manual",
          notes: null,
          legSeq: 0,
          operating: true,
        },
      ],
    });
    const onSubmitted = vi.fn();

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={onSubmitted}
      />,
    );

    // The airline code ("EK") is a fixed adornment, not typed - only the digits go into the input.
    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);

    const card = await screen.findByTestId("autofill-card");
    expect(card).toHaveTextContent("DXB → LHR");

    await user.click(screen.getByRole("button", { name: /add to roster/i }));

    await waitFor(() => expect(createTrip).toHaveBeenCalled());
    const payload = vi.mocked(createTrip).mock.calls[0]?.[0];
    expect(payload!.legs[0]).toMatchObject({
      flightNo: "EK412",
      origin: "DXB",
      dest: "LHR",
      depUtc: "2026-08-20T05:15:00.000Z",
      arrUtc: "2026-08-20T12:35:00.000Z",
    });
    // reportUtc is never included in the saved payload - the server derives it (dep - 90min)
    // from depUtc when absent.
    expect(payload!.legs[0]).not.toHaveProperty("reportUtc");

    await waitFor(() => expect(confirmSchedule).toHaveBeenCalled());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it("add flow: renders no report input or chip anywhere in the autofill card (flight-code-only entry)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue({
      legs: [
        {
          legSeq: 0,
          origin: "DXB",
          dest: "LHR",
          depLocal: "09:15",
          arrLocal: "13:35",
          dayOffset: 0,
          originTz: "Asia/Dubai",
          destTz: "Europe/London",
          confirmCount: 3,
        },
      ],
    });

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("autofill-card");

    expect(screen.queryByTestId("report-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(/report/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/report/i)).not.toBeInTheDocument();
  });

  it("shows a muted 'checking schedule…' line and disables Add while the lookup is in flight", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveLookup!: (
      value: Awaited<ReturnType<typeof lookupSchedule>>,
    ) => void;
    vi.mocked(lookupSchedule).mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);

    expect(await screen.findByTestId("schedule-loading")).toHaveTextContent(
      /checking schedule/i,
    );
    // No manual-fallback link while still resolving - only after the lookup settles.
    expect(screen.queryByTestId("manual-expand")).not.toBeInTheDocument();

    await waitFor(() =>
      resolveLookup({
        legs: [
          {
            legSeq: 0,
            origin: "DXB",
            dest: "LHR",
            depLocal: "09:15",
            arrLocal: "13:35",
            dayOffset: 0,
            originTz: "Asia/Dubai",
            destTz: "Europe/London",
            confirmCount: 3,
          },
        ],
      }),
    );

    await screen.findByTestId("autofill-card");
    expect(screen.queryByTestId("schedule-loading")).not.toBeInTheDocument();
  });

  it("renders the Add button as soon as the flight number matches the pattern, before the lookup resolves", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockReturnValue(new Promise(() => {})); // never resolves in this test

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /add to roster/i }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);

    const addButton = await screen.findByRole("button", {
      name: /^add to roster$/i,
    });
    expect(addButton).toBeEnabled();
  });

  it("pressing Add while the lookup is still resolving queues the submit and saves once it resolves", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveLookup!: (
      value: Awaited<ReturnType<typeof lookupSchedule>>,
    ) => void;
    vi.mocked(lookupSchedule).mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    vi.mocked(createTrip).mockResolvedValue({
      id: "trip-1",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [],
    });

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);

    const addButton = await screen.findByRole("button", {
      name: /^add to roster$/i,
    });
    await user.click(addButton);

    expect(screen.getByRole("button", { name: /adding/i })).toBeInTheDocument();
    expect(createTrip).not.toHaveBeenCalled();

    await waitFor(() =>
      resolveLookup({
        legs: [
          {
            legSeq: 0,
            origin: "DXB",
            dest: "LHR",
            depLocal: "09:15",
            arrLocal: "13:35",
            dayOffset: 0,
            originTz: "Asia/Dubai",
            destTz: "Europe/London",
            confirmCount: 3,
          },
        ],
      }),
    );

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(createTrip).mock.calls[0]?.[0];
    expect(payload!.legs[0]).toMatchObject({
      flightNo: "EK412",
      origin: "DXB",
      dest: "LHR",
    });
  });

  it("pressing Add while resolving, then hitting a lookup miss, saves nothing and shows the manual-entry link", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveLookup!: (
      value: Awaited<ReturnType<typeof lookupSchedule>>,
    ) => void;
    vi.mocked(lookupSchedule).mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);

    const addButton = await screen.findByRole("button", {
      name: /^add to roster$/i,
    });
    await user.click(addButton);
    expect(screen.getByRole("button", { name: /adding/i })).toBeInTheDocument();

    await waitFor(() => resolveLookup(null));

    expect(await screen.findByTestId("manual-expand")).toBeInTheDocument();
    expect(createTrip).not.toHaveBeenCalled();
  });

  it("editing the flight number after pressing Add cancels the queued submit - no auto-save, even once the stale lookup resolves", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveFirst!: (
      value: Awaited<ReturnType<typeof lookupSchedule>>,
    ) => void;
    vi.mocked(lookupSchedule).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "412");
    await vi.advanceTimersByTimeAsync(400);

    const addButton = await screen.findByRole("button", {
      name: /^add to roster$/i,
    });
    await user.click(addButton);
    expect(screen.getByRole("button", { name: /adding/i })).toBeInTheDocument();

    // Changed their mind before the queued lookup resolved - clear and enter a different number.
    await user.clear(screen.getByTestId("flightno-input"));
    vi.mocked(lookupSchedule).mockResolvedValueOnce({
      legs: [
        {
          legSeq: 0,
          origin: "DXB",
          dest: "AUH",
          depLocal: "10:00",
          arrLocal: "11:00",
          dayOffset: 0,
          originTz: "Asia/Dubai",
          destTz: "Asia/Dubai",
          confirmCount: 1,
        },
      ],
    });
    await user.type(screen.getByTestId("flightno-input"), "500");
    await vi.advanceTimersByTimeAsync(400);

    // The new number's own preview arrives, but the button is back to non-busy - the earlier
    // press was dropped, not carried over as an auto-submit on the edited number.
    await screen.findByTestId("autofill-card");
    expect(
      screen.getByRole("button", { name: /^add to roster$/i }),
    ).toBeInTheDocument();
    expect(createTrip).not.toHaveBeenCalled();

    // The stale first lookup finally resolving shouldn't retroactively trigger a save either.
    await waitFor(() =>
      resolveFirst({
        legs: [
          {
            legSeq: 0,
            origin: "DXB",
            dest: "LHR",
            depLocal: "09:15",
            arrLocal: "13:35",
            dayOffset: 0,
            originTz: "Asia/Dubai",
            destTz: "Europe/London",
            confirmCount: 3,
          },
        ],
      }),
    );
    expect(createTrip).not.toHaveBeenCalled();
  });

  it("does not render manual-expand until a lookup actually misses (not on a fresh form)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    // Fresh form, no input yet - manual-expand doesn't exist at all.
    expect(screen.queryByTestId("manual-expand")).not.toBeInTheDocument();

    vi.mocked(lookupSchedule).mockResolvedValue(null);
    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);

    expect(await screen.findByTestId("manual-expand")).toBeInTheDocument();
  });

  it("a schedule miss offers a SECOND sector, reachable in one tap", async () => {
    // The failure this exists for, verbatim from the crew member: she flew DXB→SEZ→TNR, typed
    // EK707, got no schedule, and concluded the app could not take two flights in one day. She
    // recorded the first sector only and split the way home across two days.
    //
    // Every multi-sector control on this form is gated on a schedule `preview` — both boarding
    // pickers and "+ add flight" — so on a miss the manual form is the ONLY route to a second
    // sector. This asserts the route is both signposted and one tap away.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue(null);

    render(<AddTripForm isoDate="2026-09-24" homeTz="Asia/Dubai" onSubmitted={vi.fn()} />);

    await user.type(screen.getByTestId("flightno-input"), "707");
    await vi.advanceTimersByTimeAsync(400);

    // Signposted: the miss says a duty can hold more than one sector.
    expect(await screen.findByTestId("manual-multi-hint")).toHaveTextContent(/add a leg for each/i);

    // One tap in, and the control the hint promises is there.
    await user.click(screen.getByTestId("manual-expand"));
    const addLeg = await screen.findByTestId("add-leg");

    // One sector to start with; adding one gives her the DXB→SEZ→TNR shape she needed.
    expect(screen.getAllByLabelText(/^origin$/i)).toHaveLength(1);
    await user.click(addLeg);
    expect(screen.getAllByLabelText(/^origin$/i)).toHaveLength(2);
  });

  it("falls back to the manual multi-leg fields on an unknown flight (404)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue(null);

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);

    expect(await screen.findByTestId("manual-fallback")).toBeInTheDocument();
    // The line she needed and did not have: this form takes more than one sector. A crew
    // member read "enter manually" and concluded two flights in one day were impossible.
    expect(screen.getByTestId("manual-multi-hint")).toHaveTextContent(/add a leg for each/i);
    await user.click(screen.getByTestId("manual-expand"));

    const depInput = screen.getByLabelText(/departure/i) as HTMLInputElement;
    expect(depInput.value).toBe("2026-08-20T00:00");

    // Manual fallback has no report row (flight-code-only entry).
    expect(screen.queryByLabelText(/report/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/report \(local\)/i)).not.toBeInTheDocument();
  });

  it("manual entry: after a successful save, fires onSubmitted the same as the autofill path", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue(null);
    vi.mocked(getAirport).mockImplementation(async (iata: string) => {
      if (iata === "DXB")
        return {
          iata: "DXB",
          city: "Dubai",
          name: "Dubai Intl",
          tz: "Asia/Dubai",
        };
      if (iata === "LHR")
        return {
          iata: "LHR",
          city: "London",
          name: "Heathrow",
          tz: "Europe/London",
        };
      return null;
    });
    vi.mocked(createTrip).mockResolvedValue({
      id: "trip-manual",
      userId: "u1",
      label: null,
      createdAt: Date.now(),
      flights: [],
    });
    const onSubmitted = vi.fn();

    render(
      <AddTripForm
        isoDate="2026-08-20"
        homeTz="Asia/Dubai"
        onSubmitted={onSubmitted}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByTestId("manual-fallback");
    await user.click(screen.getByTestId("manual-expand"));

    // Flight-no field is already prefilled ("EK999") by switchToManual - no need to type it.
    await user.type(screen.getByLabelText(/^origin$/i), "DXB");
    await user.tab();
    await user.type(screen.getByLabelText(/^dest$/i), "LHR");
    await user.tab();
    const depInput = screen.getByLabelText(/departure/i);
    await user.clear(depInput);
    await user.type(depInput, "2026-08-20T09:15");
    const arrInput = screen.getByLabelText(/arrival/i);
    await user.clear(arrInput);
    await user.type(arrInput, "2026-08-20T13:35");
    await user.click(screen.getByRole("button", { name: /add to roster/i }));

    await waitFor(() => expect(createTrip).toHaveBeenCalled());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  describe("turnaround chaining (+ add flight)", () => {
    // Same real seed rows as useTripEntry.test.ts's appendFlight suite (scripts/ek-schedules.json):
    // EK097 DXB->BCN dep 08:20 arr 12:35 (dayOffset 0); EK098 BCN->DXB dep 14:15 arr 00:05 (dayOffset 1).
    const EK097_LEGS = [
      {
        legSeq: 0,
        origin: "DXB",
        dest: "BCN",
        depLocal: "08:20",
        arrLocal: "12:35",
        dayOffset: 0,
        originTz: "Asia/Dubai",
        destTz: "Europe/Madrid",
        confirmCount: 2,
      },
    ];
    const EK098_LEGS = [
      {
        legSeq: 0,
        origin: "BCN",
        dest: "DXB",
        depLocal: "14:15",
        arrLocal: "00:05",
        dayOffset: 1,
        originTz: "Europe/Madrid",
        destTz: "Asia/Dubai",
        confirmCount: 2,
      },
    ];

    async function previewEk097(user: ReturnType<typeof userEvent.setup>) {
      vi.mocked(lookupSchedule).mockResolvedValueOnce({ legs: EK097_LEGS });
      render(
        <AddTripForm
          isoDate="2026-08-20"
          homeTz="Asia/Dubai"
          onSubmitted={vi.fn()}
        />,
      );
      await user.type(screen.getByTestId("flightno-input"), "097");
      await vi.advanceTimersByTimeAsync(400);
      await screen.findByTestId("autofill-card");
    }

    it("shows '+ add flight' only in preview state, chains EK098 into one combined save, and lets ✕ revert it", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await previewEk097(user);

      expect(screen.getByTestId("append-flight")).toBeInTheDocument();

      await user.click(screen.getByTestId("append-flight"));
      const appendInput = screen.getByTestId("append-flightno-input");

      vi.mocked(lookupSchedule).mockResolvedValueOnce({ legs: EK098_LEGS });
      await user.type(appendInput, "098");
      await user.keyboard("{Enter}");

      const appendedCard = await screen.findByTestId("appended-card");
      expect(appendedCard).toHaveTextContent("BCN → DXB");
      // The "+ add flight" control is hidden once a flight is appended - the ✕ is the only
      // way back to single-flight state.
      expect(screen.queryByTestId("append-flight")).not.toBeInTheDocument();

      vi.mocked(createTrip).mockResolvedValue({
        id: "trip-1",
        userId: "u1",
        label: null,
        createdAt: Date.now(),
        flights: [],
      });

      await user.click(screen.getByRole("button", { name: /add to roster/i }));

      await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1));
      const payload = vi.mocked(createTrip).mock.calls[0]?.[0];
      // ONE trip, two legs, combined save (not two POSTs).
      expect(payload!.legs).toHaveLength(2);
      // Leading zeros are stripped by normaliseFlightNo at the submit boundary (EK097 -> EK97).
      expect(payload!.legs[0]).toMatchObject({
        flightNo: "EK97",
        origin: "DXB",
        dest: "BCN",
      });
      expect(payload!.legs[1]).toMatchObject({
        flightNo: "EK98",
        origin: "BCN",
        dest: "DXB",
      });
    });

    it("reverts to single-flight preview when the appended card's ✕ is clicked", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await previewEk097(user);

      await user.click(screen.getByTestId("append-flight"));
      vi.mocked(lookupSchedule).mockResolvedValueOnce({ legs: EK098_LEGS });
      await user.type(screen.getByTestId("append-flightno-input"), "098");
      await user.keyboard("{Enter}");
      await screen.findByTestId("appended-card");

      await user.click(screen.getByTestId("remove-appended"));

      expect(screen.queryByTestId("appended-card")).not.toBeInTheDocument();
      expect(screen.getByTestId("autofill-card")).toHaveTextContent(
        "DXB → BCN",
      );
      expect(screen.getByTestId("autofill-card")).not.toHaveTextContent(
        "BCN → DXB",
      );
      // Back to single-flight preview: the "+ add flight" control is available again.
      expect(screen.getByTestId("append-flight")).toBeInTheDocument();
    });

    it("shows an inline muted error for an appended flight number with no schedule row, without falling back to manual mode", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await previewEk097(user);

      await user.click(screen.getByTestId("append-flight"));
      vi.mocked(lookupSchedule).mockResolvedValueOnce(null);
      await user.type(screen.getByTestId("append-flightno-input"), "999");
      await user.keyboard("{Enter}");

      expect(await screen.findByText(/unknown flight/i)).toBeInTheDocument();
      // No manual-entry form appeared - the outbound preview is untouched.
      expect(screen.queryByTestId("manual-fallback")).not.toBeInTheDocument();
      expect(screen.getByTestId("autofill-card")).toBeInTheDocument();
      expect(screen.queryByTestId("manual-expand")).not.toBeInTheDocument();
    });
  });

  it("waits for an airport lookup still in flight instead of calling the airport unknown", async () => {
    // The real defect, found in a CI trace: the form was fully filled, DXB and BAH were both
    // valid, the button was pressed — and no POST was ever made, because the submit read an
    // airport map that had not been filled in yet and reported "unknown airport". A fast typist
    // on a slow network gets exactly this, and the tap is silently thrown away.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue(null); // unknown flight -> the manual path
    vi.mocked(createTrip).mockResolvedValue({} as never);

    // DXB comes back at once. BAH is still open when Add is pressed.
    // ONE deferred promise, made up front. A mockImplementation that builds a new promise per
    // call hands back a fresh resolver on any repeat lookup, and the resolver this test holds
    // would then settle a promise nobody is waiting on.
    let resolveBah!: (a: Airport | null) => void;
    const bahPending = new Promise<Airport | null>((resolve) => {
      resolveBah = resolve;
    });
    vi.mocked(getAirport).mockImplementation((code: string) =>
      code.toUpperCase() === "BAH"
        ? bahPending
        : Promise.resolve({
            iata: "DXB",
            city: "Dubai",
            name: "Dubai Intl",
            tz: "Asia/Dubai",
          }),
    );

    render(
      <AddTripForm
        isoDate="2026-11-09"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);
    await user.click(await screen.findByTestId("manual-expand"));

    await user.clear(screen.getByLabelText(/flight no/i));
    await user.type(screen.getByLabelText(/flight no/i), "EK999");
    await user.type(screen.getByLabelText(/^origin$/i), "DXB");
    await user.tab();
    await user.type(screen.getByLabelText(/^dest$/i), "BAH");
    await user.tab();
    // Times last, and only once the resolved origin has landed in state: the lookup's re-render
    // rewrites the departure field, so anything set before it is thrown away.
    await vi.advanceTimersByTimeAsync(0);
    // fireEvent.change, not type(): a datetime-local input takes its value whole, and typing it
    // character by character leaves it invalid.
    fireEvent.change(screen.getByLabelText(/departure \(local\)/i), {
      target: { value: "2026-11-09T06:00" },
    });
    fireEvent.change(screen.getByLabelText(/arrival \(local\)/i), {
      target: { value: "2026-11-09T07:10" },
    });
    // The instrument, before relying on it: if the field did not take the value, the failure
    // below would be about dates, not about the airport race this test is for.
    expect(
      (screen.getByLabelText(/departure \(local\)/i) as HTMLInputElement).value,
    ).toBe("2026-11-09T06:00");

    await user.click(screen.getByRole("button", { name: /add to roster/i }));

    // Waiting, not failing: no request yet, and above all no lie about the airport.
    expect(createTrip).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/known origin and destination/i),
    ).not.toBeInTheDocument();

    resolveBah({
      iata: "BAH",
      city: "Manama",
      name: "Bahrain Intl",
      tz: "Asia/Bahrain",
    });

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/known origin and destination/i),
    ).not.toBeInTheDocument();
  });

  it("still refuses an airport nobody could resolve", async () => {
    // The guard has to keep working: waiting for a lookup must not turn into ignoring the answer.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lookupSchedule).mockResolvedValue(null);
    vi.mocked(createTrip).mockResolvedValue({} as never);
    vi.mocked(getAirport).mockImplementation((code: string) =>
      Promise.resolve(
        code.toUpperCase() === "DXB"
          ? { iata: "DXB", city: "Dubai", name: "Dubai Intl", tz: "Asia/Dubai" }
          : null,
      ),
    );

    render(
      <AddTripForm
        isoDate="2026-11-09"
        homeTz="Asia/Dubai"
        onSubmitted={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("flightno-input"), "999");
    await vi.advanceTimersByTimeAsync(400);
    await user.click(await screen.findByTestId("manual-expand"));

    await user.clear(screen.getByLabelText(/flight no/i));
    await user.type(screen.getByLabelText(/flight no/i), "EK999");
    await user.type(screen.getByLabelText(/^origin$/i), "DXB");
    await user.tab();
    await user.type(screen.getByLabelText(/^dest$/i), "ZZZ");
    await user.tab();
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.change(screen.getByLabelText(/departure \(local\)/i), {
      target: { value: "2026-11-09T06:00" },
    });
    fireEvent.change(screen.getByLabelText(/arrival \(local\)/i), {
      target: { value: "2026-11-09T07:10" },
    });

    await user.click(screen.getByRole("button", { name: /add to roster/i }));

    expect(
      await screen.findByText(/known origin and destination/i),
    ).toBeInTheDocument();
    expect(createTrip).not.toHaveBeenCalled();
  });
});

import { useEffect, useRef, useState } from "react";
import type { Airport, LegInput, ScheduleLeg } from "@danyeowa/shared";
import {
  TripInputSchema,
  addDaysIso,
  legDatesFromPicked,
  normaliseFlightNo,
  wallToUtc,
} from "@danyeowa/shared";
import { confirmSchedule, createTrip, getAirport, lookupSchedule } from "./api";
import type { TripWithFlights } from "./api";

export type LegDraft = {
  flightNo: string;
  origin: string;
  dest: string;
  dep: string; // datetime-local wall time at origin
  arr: string; // datetime-local wall time at dest
};

function emptyLeg(): LegDraft {
  return { flightNo: "", origin: "", dest: "", dep: "", arr: "" };
}

/** Converts a `YYYY-MM-DDTHH:mm` datetime-local value to the wall-ISO seconds format wallToUtc expects. */
function toWallIso(datetimeLocal: string): string {
  return datetimeLocal.length === 16 ? `${datetimeLocal}:00` : datetimeLocal;
}

const FLIGHT_NO_PATTERN = /^[A-Z]{2}\d{1,4}$/;
const LOOKUP_DEBOUNCE_MS = 400;

/** One autofilled leg, editable inline before save. Times are local HH:MM strings.
 * `flightNo` is per-leg (not hoisted to a single trip-wide value) so an appended flight's
 * legs can carry their own flight number alongside the outbound's legs in the same list. */
export type AutofillLegDraft = {
  flightNo: string;
  legSeq: number;
  /** This leg's own index WITHIN `flightNo`'s schedule (always 0-based per flight), distinct
   * from `legSeq` (the combined-trip's continuing leg_seq across an outbound + appended
   * flight). `flight_schedules` rows are keyed by (flightNo, leg_seq) PER FLIGHT — confirming
   * a leg back to the crowd layer (POST /schedule/confirm) must upsert against this, not the
   * trip-relative `legSeq`, or an appended second flight (whose combined legSeq starts above
   * 0) would confirm into a nonexistent leg_seq slot for its OWN flight_no, fabricating a
   * phantom extra leg that GET /schedule/lookup would then return on every future lookup. */
  scheduleLegSeq: number;
  origin: string;
  dest: string;
  destTz: string;
  originTz: string;
  depDate: string; // YYYY-MM-DD, from legDatesFromPicked
  depTime: string; // HH:MM, editable
  arrTime: string; // HH:MM, editable
  dayOffset: number;
};

/** Builds autofill drafts for `legs`, dating them via `legDatesFromPicked` from `pickedDate`
 * (the FIRST of these legs' departure day - the caller passes the appropriate anchor: the
 * originally picked date for the outbound, or the last existing leg's arrival date when
 * appending a second flight). `legSeq` (the combined TRIP's leg_seq, used in the POST
 * /api/trips payload) is renumbered continuing from `legSeqOffset` so an appended flight's
 * legs sort after the outbound's in the combined list; `scheduleLegSeq` (this flight's OWN
 * schedule leg index, used only for POST /schedule/confirm) always starts at 0 regardless of
 * `legSeqOffset`. */
function autofillLegsFrom(
  pickedDate: string,
  flightNo: string,
  legs: ScheduleLeg[],
  legSeqOffset = 0,
): AutofillLegDraft[] {
  const depDates = legDatesFromPicked(pickedDate, legs);
  return legs.map((leg, i) => ({
    flightNo,
    legSeq: legSeqOffset + i,
    scheduleLegSeq: i,
    origin: leg.origin,
    dest: leg.dest,
    originTz: leg.originTz,
    destTz: leg.destTz,
    depDate: depDates[i]!,
    depTime: leg.depLocal,
    arrTime: leg.arrLocal,
    dayOffset: leg.dayOffset,
  }));
}

export type EntryMode = "flightno" | "manual";

type Options = {
  /** Local ISO date ("YYYY-MM-DD") of the day this entry is for. */
  pickedDate: string;
  homeTz: string;
  /** Called after a successful save with the created trip (server-resolved depTz/arrTz
   * included) — callers that need the full saved span (e.g. rapid-entry's next-date
   * suggestion) don't have to re-derive it from client-side draft state. */
  onSubmitted: (trip: TripWithFlights) => void;
};

/**
 * Reusable flight-entry logic extracted from the Plan-5 TripForm stepper: flight-no lookup
 * (debounced), autofill preview editing, manual-entry fallback, and save (createTrip +
 * fire-and-forget confirmSchedule). `reportUtc` is intentionally never included in the saved
 * payload (Plan 10 Task 3) — the server derives it from `depUtc` on create.
 */
export function useTripEntry({ pickedDate, homeTz, onSubmitted }: Options) {
  const [mode, setMode] = useState<EntryMode>("flightno");

  const [flightNo, setFlightNo] = useState("");
  const [autofillLegs, setAutofillLegs] = useState<AutofillLegDraft[] | null>(
    null,
  );
  /**
   * Index of the last leg the crew member actually works, or null for "all of them".
   *
   * A multi-sector flight number is one aircraft routing, not one crew duty: EK205 is
   * DXB->MXP->JFK and the crew can change at Milan. Null (not `length - 1`) is the default so
   * appending a leg with "+ add flight" keeps meaning "all of it" without having to be kept in
   * step with the list's length.
   */
  const [finalLegIndex, setFinalLegIndex] = useState<number | null>(null);
  /**
   * Which leg she BOARDS. The mirror of `finalLegIndex`, and the one that decides what the
   * picked date means: a roster dates a duty by the sector she flies, so "26 Aug EK248" from
   * someone who joins at Rio puts the RIO departure on the 26th — the EZE sector the aircraft
   * flew before she got on belongs to the 25th. Reading the picked date as leg 0's date
   * regardless is what put a whole pairing a day late and had the calendar say she came home on
   * Thursday for a Friday-morning arrival. Null (not 0) for the same reason as `finalLegIndex`.
   */
  const [boardingLegIndex, setBoardingLegIndex] = useState<number | null>(null);
  const [autofillFlightNo, setAutofillFlightNo] = useState<string | null>(null);
  const [lookupMiss, setLookupMiss] = useState(false);
  // True while a debounced schedule lookup's fetch is in flight (not during the debounce
  // delay itself) — drives the "checking schedule…" muted line.
  const [resolving, setResolving] = useState(false);
  // True once the user presses Add before a lookup has resolved (requestSubmit) — the effect
  // below consumes it as soon as autofillLegs arrives (submit) or the lookup misses (drop it).
  // Cleared immediately if the flight number changes, so an edited-away number never saves.
  const [pendingSubmit, setPendingSubmit] = useState(false);

  // Turnaround chaining (Task 2): an appended second flight's own flight number and legs,
  // tracked separately from the outbound so the "✕ remove appended" revert can drop exactly
  // these legs back out of `autofillLegs` without touching the outbound's own draft state.
  const [appendedFlightNo, setAppendedFlightNo] = useState<string | null>(null);
  const [appendLookupMiss, setAppendLookupMiss] = useState(false);

  const [legs, setLegs] = useState<LegDraft[]>([
    { ...emptyLeg(), dep: `${pickedDate}T00:00` },
  ]);
  const [airports, setAirports] = useState<Map<string, Airport | null>>(
    new Map(),
  );
  // Lookups that have been started but have not answered yet. A code that is merely still in
  // flight is NOT the same as a code that turned out not to be an airport, and `airports` alone
  // cannot tell them apart — it is empty in both cases. Submitting used to read that emptiness
  // as "unknown airport", so tapping Add straight after typing DXB rejected DXB. A ref, not
  // state: it is read inside an async submit, where a re-render would not have reached the
  // closure anyway.
  const pendingLookups = useRef(new Map<string, Promise<Airport | null>>());
  const [unknown, setUnknown] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Debounced schedule lookup on a valid flight-no pattern.
  useEffect(() => {
    // Any change that reaches here (a keystroke, a mode switch, a new picked date) means a
    // submit queued by requestSubmit() while the previous lookup was still resolving no
    // longer applies — don't save against a flight number the user has since edited away from.
    setPendingSubmit(false);
    if (mode !== "flightno") return;
    const candidate = normaliseFlightNo(flightNo);
    if (!FLIGHT_NO_PATTERN.test(candidate)) {
      setAutofillLegs(null);
      setAutofillFlightNo(null);
      setLookupMiss(false);
      setResolving(false);
      return;
    }
    const timer = setTimeout(async () => {
      setResolving(true);
      try {
        const result = await lookupSchedule(candidate, pickedDate);
        if (result) {
          setAutofillLegs(autofillLegsFrom(pickedDate, candidate, result.legs));
          // A different flight number is a different routing — never carry a stale pick over.
          setFinalLegIndex(null);
          setBoardingLegIndex(null);
          setAutofillFlightNo(candidate);
          setLookupMiss(false);
          // A new outbound lookup replaces whatever was previewed before, including any
          // appended flight from a prior preview.
          setAppendedFlightNo(null);
          setAppendLookupMiss(false);
        } else {
          setAutofillLegs(null);
          setAutofillFlightNo(null);
          setLookupMiss(true);
        }
      } catch {
        // The schedule service is unreachable (e.g. a non-404 error from the live provider
        // chain) — treat it the same as a miss so the user can still fall back to manual
        // entry instead of getting stuck on "checking schedule…" forever.
        setAutofillLegs(null);
        setAutofillFlightNo(null);
        setLookupMiss(true);
      } finally {
        setResolving(false);
      }
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [flightNo, mode, pickedDate]);

  // Consumes a submit queued by requestSubmit(): fires the save the moment the lookup it was
  // waiting on settles into a preview, or drops it silently on a miss (the existing lookupMiss
  // UI already surfaces the manual-entry link — nothing else to do here).
  useEffect(() => {
    if (!pendingSubmit) return;
    if (autofillLegs && autofillFlightNo) {
      setPendingSubmit(false);
      void handleAutofillSubmit();
    } else if (lookupMiss) {
      setPendingSubmit(false);
    }
  }, [pendingSubmit, autofillLegs, autofillFlightNo, lookupMiss]);

  /**
   * Chains a second, schedule-known flight onto the current autofill preview as one combined
   * trip (turnaround path). The appended flight's first leg departs on the LAST existing leg's
   * ARRIVAL local date — that's the earliest calendar day the next flight can operate — and the
   * rest of its legs (if multi-leg) date via the same `legDatesFromPicked` continuation rules
   * applied to the combined list, so the existing roll-forward guard for impossible connections
   * (e.g. a genuine overnight ground stop) covers the appended boundary exactly like any other
   * leg-to-leg connection; no changes to `legDatesFromPicked` were needed. Scope is intentionally
   * tight: a lookup miss shows an inline error and does NOT fall back to manual entry — manual
   * turnarounds remain possible via the pre-existing multi-leg manual path.
   */
  async function appendFlight(candidateFlightNo: string) {
    setAppendLookupMiss(false);
    if (!autofillLegs || autofillLegs.length === 0) return;
    const candidate = normaliseFlightNo(candidateFlightNo);
    if (!FLIGHT_NO_PATTERN.test(candidate)) {
      setAppendLookupMiss(true);
      return;
    }
    const lastLeg = autofillLegs[autofillLegs.length - 1]!;
    const anchorDate = addDaysIso(lastLeg.depDate, lastLeg.dayOffset);
    const result = await lookupSchedule(candidate, anchorDate);
    if (!result) {
      setAppendLookupMiss(true);
      return;
    }
    const appended = autofillLegsFrom(
      anchorDate,
      candidate,
      result.legs,
      lastLeg.legSeq + 1,
    );
    setAutofillLegs((prev) => (prev ? [...prev, ...appended] : appended));
    setAppendedFlightNo(candidate);
    setAppendLookupMiss(false);
  }

  /** Reverts the "+ add flight" chain back to single-flight state, dropping every leg tagged
   * with the appended flight number. */
  function removeAppendedFlight() {
    if (!appendedFlightNo) return;
    setAutofillLegs((prev) =>
      prev ? prev.filter((leg) => leg.flightNo !== appendedFlightNo) : prev,
    );
    setAppendedFlightNo(null);
    setAppendLookupMiss(false);
  }

  /**
   * Picks the sector she boards, and slides the whole routing so that sector sits on the picked
   * date. Re-derived through `legDatesFromPicked` rather than by adding days here, so the
   * cross-midnight roll-forward rule stays in one tested place; the leg TIMES are passed back in
   * as they currently stand, so a time the crew has already corrected by hand survives the move.
   */
  function setBoardingLeg(index: number) {
    setAutofillLegs((prev) => {
      if (!prev) return prev;
      const dates = legDatesFromPicked(
        pickedDate,
        prev.map((leg) => ({
          dayOffset: leg.dayOffset,
          depLocal: leg.depTime,
          arrLocal: leg.arrTime,
        })),
        index,
      );
      return prev.map((leg, i) => ({ ...leg, depDate: dates[i]! }));
    });
    setBoardingLegIndex(index);
    // Boarding after the sector she had marked as her last would leave her working nothing.
    setFinalLegIndex((last) => (last !== null && last < index ? index : last));
  }

  function updateAutofillLeg(index: number, patch: Partial<AutofillLegDraft>) {
    setAutofillLegs((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
  }

  function switchToManual() {
    setLegs([
      {
        ...emptyLeg(),
        flightNo: normaliseFlightNo(flightNo),
        dep: `${pickedDate}T00:00`,
      },
    ]);
    setMode("manual");
  }

  /** Returns to the flight-no entry screen — used after a successful manual save so the
   * caller's shared post-save transition (rapid-entry banner, chips, cleared+refocused
   * input) renders the same way it does after an autofill save. */
  function switchToFlightNo() {
    setMode("flightno");
  }

  function updateLeg(index: number, patch: Partial<LegDraft>) {
    setLegs((prev) => {
      const current = prev[index];
      if (!current) return prev;
      const merged: LegDraft = { ...current, ...patch };
      const next = [...prev];
      next[index] = merged;
      return next;
    });
  }

  async function lookupAirport(iata: string) {
    const code = iata.toUpperCase();
    if (!code || airports.has(code)) return;
    // Registered before awaiting, and reused if the same code is asked for twice while the
    // first request is still open, so a submit can wait on exactly this request.
    let inFlight = pendingLookups.current.get(code);
    if (!inFlight) {
      inFlight = getAirport(code);
      pendingLookups.current.set(code, inFlight);
    }
    const airport = await inFlight;
    pendingLookups.current.delete(code);
    setAirports((prev) => new Map(prev).set(code, airport));
    setUnknown((prev) => {
      const next = new Set(prev);
      if (airport) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function addLeg() {
    setLegs((prev) => {
      const last = prev[prev.length - 1];
      const leg = emptyLeg();
      leg.origin = last?.dest ?? "";
      leg.dep = last?.arr ? `${last.arr.slice(0, 10)}T00:00` : "";
      return [...prev, leg];
    });
  }

  function airportLabel(iata: string): string | null {
    const code = iata.toUpperCase();
    if (!code) return null;
    if (unknown.has(code)) return `unknown airport: ${code}`;
    return airports.get(code)?.city ?? null;
  }

  async function handleAutofillSubmit() {
    setError(null);
    if (!autofillLegs || !autofillFlightNo) return;

    const resolvedLegs: LegInput[] = [];
    const confirmPayloads: {
      flightNo: string;
      legSeq: number;
      origin: string;
      dest: string;
      depLocal: string;
      arrLocal: string;
      dayOffset: number;
    }[] = [];

    // Everything outside the sectors she works is the aircraft's own routing — what it flew to
    // reach her, and where it goes after she gets off. Stored so the routing stays true, flagged
    // so no derived time (landing, report, day marks, alerts) counts it.
    const firstOperating = boardingLegIndex ?? 0;
    const lastOperating = finalLegIndex ?? autofillLegs.length - 1;

    for (const [index, leg] of autofillLegs.entries()) {
      const operating = index >= firstOperating && index <= lastOperating;
      const depUtc = wallToUtc(
        `${leg.depDate}T${leg.depTime}:00`,
        leg.originTz,
      );
      // Arrival date = this leg's own dep date + this leg's own dayOffset (arr date - dep date).
      const arrDate = addDaysIso(leg.depDate, leg.dayOffset);
      const arrUtc = wallToUtc(`${arrDate}T${leg.arrTime}:00`, leg.destTz);

      // reportUtc intentionally omitted — the server derives it (dep - 90min) when absent.
      resolvedLegs.push({
        flightNo: leg.flightNo,
        origin: leg.origin,
        dest: leg.dest,
        depUtc,
        arrUtc,
        operating,
      });
      // Only sectors she actually worked are reported back to the crowd layer. She can vouch
      // for the times she flew; a sector she got off before is hearsay, and `scheduleLegSeq` is
      // this leg's index within the flight's OWN schedule, so it is never re-indexed here.
      if (operating) {
        confirmPayloads.push({
          flightNo: leg.flightNo,
          legSeq: leg.scheduleLegSeq,
          origin: leg.origin,
          dest: leg.dest,
          depLocal: leg.depTime,
          arrLocal: leg.arrTime,
          dayOffset: leg.dayOffset,
        });
      }
    }

    const parsed = TripInputSchema.safeParse({ legs: resolvedLegs });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid trip");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createTrip(parsed.data);
      // Fire-and-forget: report the (possibly edited) saved times back to the crowd layer.
      // Never blocks the UX and errors are ignored.
      for (const payload of confirmPayloads) {
        confirmSchedule(payload).catch(() => {});
      }
      onSubmitted(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create trip");
    } finally {
      setSubmitting(false);
    }
  }

  /** Add-button handler: saves immediately if the schedule lookup for the current flight
   * number has already resolved, otherwise queues the submit (see the pendingSubmit effect
   * above) so the crew never has to wait out the debounce + fetch before acting. */
  function requestSubmit() {
    if (!FLIGHT_NO_PATTERN.test(flightNo.toUpperCase())) return;
    if (!resolving && autofillLegs && autofillFlightNo) {
      void handleAutofillSubmit();
    } else {
      setPendingSubmit(true);
    }
  }

  async function handleManualSubmit() {
    setError(null);

    // Let any lookup this trip depends on finish first. Without it, a fast typist — or a slow
    // network — gets told a perfectly real airport is unknown, and the tap is silently thrown
    // away. Codes nobody ever looked up are absent here too, so a genuinely wrong code still
    // fails, with the message it deserves.
    const resolved = new Map(airports);
    await Promise.all(
      legs
        .flatMap((leg) => [leg.origin.toUpperCase(), leg.dest.toUpperCase()])
        .filter((code) => code && !resolved.has(code))
        .map(async (code) => {
          const inFlight = pendingLookups.current.get(code);
          if (inFlight) resolved.set(code, await inFlight);
        }),
    );

    const resolvedLegs: LegInput[] = [];
    for (const leg of legs) {
      const originAirport = resolved.get(leg.origin.toUpperCase());
      const destAirport = resolved.get(leg.dest.toUpperCase());
      if (!originAirport || !destAirport) {
        setError("Every leg needs a known origin and destination airport");
        return;
      }
      const depUtc = wallToUtc(toWallIso(leg.dep), originAirport.tz);
      const arrUtc = wallToUtc(toWallIso(leg.arr), destAirport.tz);
      // reportUtc intentionally omitted — the server derives it (dep - 90min) when absent.
      resolvedLegs.push({
        flightNo: normaliseFlightNo(leg.flightNo),
        origin: leg.origin,
        dest: leg.dest,
        depUtc,
        arrUtc,
      });
    }

    const parsed = TripInputSchema.safeParse({ legs: resolvedLegs });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid trip");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createTrip(parsed.data);
      onSubmitted(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create trip");
    } finally {
      setSubmitting(false);
    }
  }

  return {
    mode,
    flightNo,
    setFlightNo,
    autofillLegs,
    finalLegIndex,
    setFinalLegIndex,
    boardingLegIndex,
    setBoardingLeg,
    autofillFlightNo,
    lookupMiss,
    resolving,
    pendingSubmit,
    requestSubmit,
    flightNoValid: FLIGHT_NO_PATTERN.test(flightNo.toUpperCase()),
    updateAutofillLeg,
    switchToManual,
    switchToFlightNo,
    legs,
    updateLeg,
    lookupAirport,
    addLeg,
    airportLabel,
    error,
    submitting,
    handleAutofillSubmit,
    handleManualSubmit,
    appendedFlightNo,
    appendLookupMiss,
    appendFlight,
    removeAppendedFlight,
  };
}

export type UseTripEntryReturn = ReturnType<typeof useTripEntry>;

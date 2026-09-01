import { useEffect, useRef, useState } from "react";
import {
  clockShiftHours,
  dayOffset,
  formatDuration,
  formatHours,
  formatLocal,
  layoverHours,
  localDateKey,
  tripProgress,
  tripDaysInMonth,
} from "@danyeowa/shared";
import { deleteTrip, getCrew, getCrewTrips, getTrips } from "./api";
import type { TripWithFlights } from "./api";
import type { CrewMember } from "@danyeowa/shared";
import AddTripForm from "./AddTripForm";
import CrewBadges from "./CrewBadges";
import { WeatherGlyph } from "./WeatherGlyph";
import { WeatherField } from "./WeatherField";
import { DutyStatus } from "./DutyStatus";
import { digitsOf, getAirlinePrefix } from "./lib/airlinePrefix";
import { useAirport } from "./lib/airports";
import { CopyLayoverBrief } from "./CopyLayoverBrief";
import { humanDateLabel } from "./lib/dateLabel";
import { calendarSpan } from "./lib/dayMarks";
import { MIN_LAYOVER_FREE_HOURS } from "./lib/layoverBrief";
import { useDestinationSky, type Sky } from "./lib/useSky";
import { HOME_BASE_IATA } from "./lib/homeBase";
import { layoverRests, restForDay, type LayoverRest } from "./lib/layoverBrief";
import TripLegsPanel from "./TripLegsPanel";
import TripsCalendar from "./TripsCalendar";
import { useTripEntry } from "./useTripEntry";

/** City name for `iata`, once `useAirport` resolves it — falls back to the bare code otherwise
 * (including forever, on a failed lookup), so a slow or broken airport fetch never blocks the
 * timeline's first paint or breaks the card. `shift`, when given, appends the clock-shift
 * suffix — that's independent of the airport fetch (derived purely from the leg's own tz
 * fields), so it always shows even before the city resolves. Without `shift`, the IATA code
 * IS the suffix, so it's dropped once the city resolves rather than doubled up as "DXB · DXB". */
function StationLine({ iata, shift }: { iata: string; shift?: number }) {
  const airport = useAirport(iata);
  const city = airport?.city;
  if (shift === undefined) {
    return <p className="num text-sm text-ink-muted">{city ? `${city} · ${iata}` : iata}</p>;
  }
  return (
    <p className="num text-sm text-ink-muted">
      {city ?? iata} · clock {shift >= 0 ? "+" : ""}
      {shift}h
    </p>
  );
}

/** The date line on a day with no duty on it but a layover under it. "— no duty" alone sat
 * directly above a panel headed "Layover · Buenos Aires" and read as a blank day, which is the
 * same misreading that had the add form opening here uninvited. Resolves the city through
 * `useAirport` like StationLine does, and falls back to the bare IATA until it lands. */
function DownRouteLine({
  isoDate,
  homeTz,
  station,
}: {
  isoDate: string;
  homeTz: string;
  station: string;
}) {
  const airport = useAirport(station);
  return (
    <p className="text-sm text-ink-muted">
      {humanDateLabel(isoDate, homeTz)} — no duty, down-route in {airport?.city ?? station}
    </p>
  );
}

/** What a day with no duty of its own says about the next one. Prepared by CalendarHome, which
 * is where "next" is decided, so the card never has to re-derive it. */
type NextDutySummary = { isoDate: string; flightNo: string; route: string };

type TimelineRow = {
  key: string;
  time: string;
  icon: string;
  iconTone: string;
  label: string;
  sub?: React.ReactNode;
};

/** The full duty detail (design "C"): (Departs -> Lands) per leg, with a Layover row between
 * legs.
 *
 * NO REPORT ROW, and none on the board either — removed 2026-08-31 at the user's call. A crew
 * member's own airline app already gives her report and e-gate, so this card was restating a
 * number she reads somewhere more authoritative. Report time is still stored, still drives the
 * push alert, and still sets "free until report" on the layover panel; it just isn't printed
 * here. The first Departs row inherits the origin's station line, which the report row used to
 * carry. Every row
 * stagger-enters (`.tl-enter`, tokens.css) at 70ms * index, capped at 400ms so a long timeline
 * still finishes settling quickly — under reduced motion that class applies no animation at all,
 * so the detail simply renders present. */
function TripTimeline({ legs }: { legs: TripWithFlights["flights"] }) {
  const dutyStart = legs[0]!;
  const rows: TimelineRow[] = [];

  legs.forEach((leg, index) => {
    if (index > 0) {
      const prevLeg = legs[index - 1]!;
      // Transit and layover are different days of her life, so they get different words. A
      // two-hour stop at Rio on the way to Buenos Aires is not somewhere she goes; the same
      // row used to call it a layover, next to a "5m free until report" card and a city guide.
      const ground = layoverHours(prevLeg.arrUtc, leg.depUtc);
      const isTransit = ground < MIN_LAYOVER_FREE_HOURS;
      rows.push({
        key: `layover-${leg.id}`,
        time: formatHours(ground),
        icon: isTransit ? "◦" : "·",
        iconTone: "text-ink-muted",
        label: `${isTransit ? "Transit" : "Layover"} · ${prevLeg.dest}`,
      });
    }
    rows.push({
      key: `departs-${leg.id}`,
      time: formatLocal(leg.depUtc, leg.depTz),
      icon: "●",
      iconTone: "text-ink",
      label: "Departs",
      sub: (
        <>
          {/* Only the first sector: after that, the Lands and Layover rows above have already
              named the station she is leaving from. */}
          {index === 0 && <StationLine iata={leg.origin} />}
          <p className="num text-sm text-ink-muted">{formatDuration(leg.depUtc, leg.arrUtc)} airborne</p>
        </>
      ),
    });
    // The landing DATE, spelled out, when the sector crosses a local day. This is the one thing
    // the DEP/ARR board above used to say that the timeline did not, so it moved here when the
    // board went. Not a "+1" to add: the person reading it is waiting at an arrivals barrier and
    // needs a date, and "+1" off a departure date in another country is arithmetic nobody does
    // correctly at 1am.
    // Measured from the day the DUTY started, not from this leg's own departure. EK448 leaves
    // Dubai on the Tuesday, and its second sector both leaves Singapore and lands in Auckland on
    // the Wednesday — leg-relative that is a same-day sector and says nothing, while the fact
    // someone waiting needs is that she is down on the Wednesday.
    const landsOnAnotherDay =
      dayOffset(dutyStart.depUtc, leg.arrUtc, dutyStart.depTz, leg.arrTz) !== 0;
    const landDayLabel = formatLocal(leg.arrUtc, leg.arrTz, { withDate: true })
      .split(" ")
      .slice(0, 2)
      .join(" ");
    rows.push({
      key: `lands-${leg.id}`,
      time: formatLocal(leg.arrUtc, leg.arrTz),
      icon: "◌",
      iconTone: "text-ink-muted",
      label: landsOnAnotherDay ? `Lands · ${landDayLabel}` : "Lands",
      sub: <StationLine iata={leg.dest} shift={clockShiftHours(leg.depUtc, leg.depTz, leg.arrUtc, leg.arrTz)} />,
    });
  });

  return (
    <div data-testid="duty-timeline" className="mt-4 flex flex-col gap-3">
      {rows.map((row, i) => (
        <div
          key={row.key}
          className="tl-enter flex items-start gap-3"
          style={{ animationDelay: `${Math.min(i * 70, 400)}ms` }}
        >
          {/* w-12 (48px), not w-11 (44px): "00:00" at 5 tabular-num chars needs the extra
              margin so it never clips against a fallback monospace font's advance width. */}
          <span className="num w-12 shrink-0 text-sm text-ink-muted">{row.time}</span>
          <span aria-hidden="true" className={`${row.iconTone} leading-none`}>
            {row.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">{row.label}</p>
            {row.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

type Props = {
  now: Date;
  /** Bumped by the parent (e.g. the tab bar's center + button) to select today on the
   * calendar, or the next trip-free day if today already has a trip. */
  openTodayToken?: number;
};

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function PencilIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4 16.5V20zM14.5 6.5l3 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M9 7V4h6v3" />
    </svg>
  );
}

/** The trip's identity at a glance: route as the headline, flight and date beneath it, then the
 * sector as departure-board rows — REPORT, DEP, ARR, each a label/value pair on a hairline rule,
 * closed out by the elapsed-time figure, and (when `showTimeline`) the full duty timeline
 * underneath that. */
function TripSummaryLines({
  legs,
  homeTz,
  actions,
  showTimeline,
  timelineKey,
  sky,
}: {
  legs: TripWithFlights["flights"];
  /** Home base's zone. The header date is read in it, not in the departure station's, so the
   * date on the card is the same date as the calendar cell the card sits under — a duty that
   * leaves Buenos Aires on the 26th is the 27th's duty to everyone waiting in Dubai. */
  homeTz: string;
  /** The destination's forecast for the landing day, when there is one. The field behind the
   * card carries the feel; this line carries the numbers, because a gradient cannot say 86%. */
  sky?: Sky | null;
  /** Corner controls, rendered in the header row so they never steal width from the board. */
  actions?: React.ReactNode;
  /** Appends the full duty timeline (TripTimeline) below the board rows. */
  showTimeline?: boolean;
  /** Remounts the timeline when it changes, so the stagger plays again.
   *
   * A CSS entry animation fires once per ELEMENT, and a multi-day pairing renders the same
   * trip (same `trip.id`, so the same card, so the same rows) on every day it spans. Tapping
   * 1 Sept then 2 Sept therefore replayed nothing at all: React kept the DOM nodes and only
   * the layover panel below them changed. Passing the day here gives each day its own rows.
   * Undefined where a card has no day to key on. */
  timelineKey?: string;
}) {
  const firstLeg = legs[0]!;
  const lastLeg = legs[legs.length - 1]!;
  const routeChain = [legs[0]!.origin, ...legs.map((leg) => leg.dest)].filter(
    (stop, index, all) => index === 0 || stop !== all[index - 1],
  );
  // Out of base and back on the same local day: a turnaround. Worth naming, because on the card
  // it otherwise reads as an ordinary duty with an odd route chain — and the ground time at the
  // outstation is transit, which the timeline now says too.
  const isTurnaround =
    firstLeg.origin === HOME_BASE_IATA &&
    lastLeg.dest === HOME_BASE_IATA &&
    localDateKey(firstLeg.depUtc, firstLeg.depTz) === localDateKey(lastLeg.arrUtc, lastLeg.arrTz);

  // Length only earns a place on a pairing that actually spans days — "1 day" is noise. Counted
  // over the same span the calendar paints, so the card and the grid never disagree about how
  // many cells this duty owns.
  const span = calendarSpan(legs, HOME_BASE_IATA);
  const tripDays = span ? dayOffset(span.firstDepUtc, span.endUtc, homeTz, homeTz) + 1 : 1;
  // Weekday + day + month only: the year is never in question on a roster. Read in the home
  // zone so it matches the calendar day this card belongs to; the timeline's Lands row carries
  // the landing date separately, which is the one a red-eye actually needs.
  const depDate = formatLocal(firstLeg.depUtc, homeTz, { withDate: true }).split(" ").slice(0, 3).join(" ");
  const duration = formatDuration(firstLeg.depUtc, lastLeg.arrUtc);

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xl font-semibold tracking-tight text-ink">{routeChain.join(" → ")}</p>
          <p className="text-sm text-ink-muted">
            {firstLeg.flightNo} · {depDate}
            {tripDays > 1 && ` · ${tripDays} days`}
            {isTurnaround && " · turnaround"}
          </p>
          {sky && (
            // Third line rather than a right-hand column: the corner controls already live
            // there, and two right-aligned blocks collide at 390px.
            <p
              data-testid="card-sky"
              className="num flex items-center gap-1.5 text-sm text-ink-muted"
            >
              <WeatherGlyph kind={sky.kind} />
              <span>
                {Math.round(sky.day.tempMinC)}–{Math.round(sky.day.tempMaxC)}° · {sky.day.label}
                {sky.day.rainChance != null && ` · rain ${sky.day.rainChance}%`}
              </span>
            </p>
          )}
        </div>
        {actions}
      </div>

      {/* The DEP/ARR board is GONE, removed 2026-08-31. With REPORT already off it, every row it
          had was the timeline's own words a few lines further down: DEP 07:15 above Departs
          07:15, ARR 12:50 above Lands 12:50, and the elapsed figure above "8h 36m airborne".
          The one thing it said that the timeline did not — the landing DATE on a sector that
          crosses a local day — moved onto the Lands row.

          The elapsed time survives only on a multi-leg pairing, where it means something the
          per-leg airborne figures do not: the whole trip, ground time included. On a single
          sector it is the airborne figure again, to the minute. */}
      {legs.length > 1 && duration && (
        <p className="num mt-3 text-right text-sm text-ink-muted">{duration} total</p>
      )}

      {showTimeline && <TripTimeline key={timelineKey} legs={legs} />}
    </>
  );
}

/** The card shown below the calendar grid, for the day she has tapped or, until she taps
 * one, for today. A trip day expands IN PLACE to its legs and a delete control. An empty day shows the add-trip form (AddTripForm) directly —
 * no "Add trip" button and no bottom sheet — remounted (via a key bump) after each successful
 * add so it comes back blank while the parent's refetch flips the card to the trip view. */
function DayDetailCard({
  isoDate,
  trip,
  homeTz,
  now,
  layoverRest,
  nextDuty,
  onAdded,
  onChanged,
  readOnly = false,
}: {
  isoDate: string;
  trip: TripWithFlights | null;
  homeTz: string;
  /** Drives the status block's "where is she right now". Passed in rather than read from the
   * clock here so the card is a pure function of its inputs and testable at a fixed instant. */
  now: Date;
  /** Shown on a day with no duty: the one thing the deleted preview card used to answer. */
  nextDuty?: NextDutySummary | null;
  /** The down-route rest this day falls inside, rendered inside this card rather than beside
   * it: the rest belongs to the flight that created it, and two stacked cards made the day
   * read as two separate things. */
  layoverRest?: LayoverRest | null;
  /** Marks the day optimistically on the calendar grid ahead of the parent's refetch. */
  onAdded: (isoDate: string) => void;
  onChanged: () => void;
  /** Viewing a crew member's roster: their day is readable, never editable. The API refuses
   * the writes regardless — this only keeps controls that would always fail off the screen. */
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Bumped after every successful inline add so AddTripForm below remounts fresh (blank
  // flight-no field) instead of sitting on its just-submitted preview while the parent's
  // refetch is still in flight.
  const [addFormKey, setAddFormKey] = useState(0);
  /** Whether she has asked for the add form on a day that is already part of a journey. Reset
   * per day by the `key={isoDate}` on this card's empty-day call site. */
  const [addingHere, setAddingHere] = useState(false);
  const legs = trip ? [...trip.flights].sort((a, b) => a.legSeq - b.legSeq) : [];
  const firstLeg = legs[0] ?? null;
  const lastLeg = legs[legs.length - 1] ?? null;
  const [airlinePrefix] = useState(getAirlinePrefix);

  // The destination's sky for the day this flight lands. Called unconditionally (hook rules)
  // and inert on a trip-free day, where the empty code short-circuits the airport lookup.
  // Null for most cards: forecasts reach about 16 days and a roster runs further.
  const sky = useDestinationSky(
    lastLeg?.dest ?? "",
    lastLeg?.arrUtc ?? "",
    lastLeg?.arrTz ?? "UTC",
  );

  // Drives the pencil's edit mode with the SAME debounced-lookup + autofill + save pipeline
  // as the add sheet (useTripEntry), not a second implementation of it. Called unconditionally
  // (hook rules) even on a trip-free day, where it's simply inert - the edit UI that would
  // drive it never mounts there, so `pickedDate` falling back to the bare day is never read.
  const entry = useTripEntry({
    pickedDate: firstLeg ? localDateKey(firstLeg.depUtc, firstLeg.depTz) : isoDate,
    homeTz,
    onSubmitted: async () => {
      // Trip-free days never expose the edit UI, so `trip` is always set by the time this
      // actually fires - this guard exists only so the type checker (and any future caller)
      // doesn't have to assume it.
      if (!trip) return;
      // Create-then-delete: the hook has already created the replacement trip by the time
      // this callback runs. Only now is the original removed - a failed create above leaves
      // the old trip untouched instead of destroying a roster entry for nothing.
      try {
        await deleteTrip(trip.id);
      } catch (err) {
        setEditError(
          `Saved the new flight, but the old one may still be on your roster: ${
            err instanceof Error ? err.message : "failed to remove it"
          }`,
        );
      }
      setExpanded(false);
      onChanged();
    },
  });

  // Pencil click primes the field with the trip's CURRENT flight number (not blank) so edit
  // mode opens showing what's already on the roster - and clears any stale error from a
  // previous attempt.
  useEffect(() => {
    if (expanded && firstLeg) {
      entry.setFlightNo(firstLeg.flightNo);
      setEditError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function confirmDelete() {
    if (!trip) return;
    setDeleting(true);
    try {
      await deleteTrip(trip.id);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete trip");
      setDeleting(false);
    }
  }

  // Native <dialog> rather than a hand-rolled overlay: showModal() gives the focus trap,
  // Esc-to-close and an inert background for free, and there is no dependency to add. React
  // owns `confirmingDelete`; this only mirrors it onto the element, and onClose feeds Esc
  // (which the browser handles itself) back into state.
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (confirmingDelete && !dialog.open) dialog.showModal();
    if (!confirmingDelete && dialog.open) dialog.close();
  }, [confirmingDelete]);

  if (!trip || !firstLeg) {
    return (
      <div data-testid="day-detail-card" className="hairline flex flex-col gap-3 rounded-lg border border-edge bg-card p-4">
        {layoverRest ? (
          <DownRouteLine isoDate={isoDate} homeTz={homeTz} station={layoverRest.station} />
        ) : (
          <p className="text-sm text-ink-muted">{humanDateLabel(isoDate, homeTz)} — no duty</p>
        )}
        {/* "No duty" on its own leaves the obvious question unanswered, and answering it here is
            what let the read-only preview card go. Only when this day is not itself the next
            duty's day, or it would repeat the line above. */}
        {nextDuty && nextDuty.isoDate !== isoDate && (
          <p data-testid="next-duty-line" className="num text-sm text-ink">
            Next: {humanDateLabel(nextDuty.isoDate, homeTz)} · {nextDuty.flightNo} · {nextDuty.route}
          </p>
        )}
        {/* The day in the middle of a layover: no duty, and the one she is most likely to be
            planning. "No duty" alone is true and useless here. */}
        {layoverRest && <CopyLayoverBrief rest={layoverRest} />}
        {readOnly ? null : layoverRest && !addingHere ? (
          // A layover day has no leg DEPARTING on it, so it lands in this branch — but it is
          // not a free day, and opening the form here put the cursor in the flight-number box
          // and threw the keyboard up over a city guide she was reading. A day that is part of
          // a journey asks first, exactly like a day that already holds a duty does.
          <button
            type="button"
            data-testid="add-duty-here"
            onClick={() => setAddingHere(true)}
            className="min-h-[44px] rounded border border-dashed border-edge px-3 py-2 text-sm text-ink-muted transition-colors duration-[120ms] hover:border-accent hover:text-accent"
          >
            + Add a duty
          </button>
        ) : (
        <AddTripForm
          key={`${isoDate}-${addFormKey}`}
          isoDate={isoDate}
          homeTz={homeTz}
          onSubmitted={() => {
            onAdded(isoDate);
            onChanged();
            setAddFormKey((k) => k + 1);
          }}
        />
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="day-detail-card"
      data-sky={sky?.kind}
      className={[
        "hairline relative flex flex-col overflow-hidden rounded-lg border border-edge p-4",
        sky ? "sky" : "bg-card",
      ].join(" ")}
    >
      {sky && <WeatherField kind={sky.kind} code={sky.day.code} />}
      {/* The answer first, the detail under it. */}
      <div className="mb-4">
        <DutyStatus legs={legs} homeTz={homeTz} now={now} layoverRest={layoverRest} readOnly={readOnly} />
      </div>
      <TripSummaryLines
        sky={sky}
        legs={legs}
        homeTz={homeTz}
        showTimeline
        timelineKey={isoDate}
        actions={
          readOnly ? null : (
          // Out of the reading path: the card is read far more often than it is edited.
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              data-testid="day-detail-action"
              aria-label={expanded ? "Hide flight details" : "Edit trip"}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={[
                "flex min-h-[44px] min-w-[44px] items-center justify-center rounded transition-colors duration-[120ms]",
                expanded ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-accent",
              ].join(" ")}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              data-testid="delete-trip"
              aria-label="Delete trip"
              onClick={() => setConfirmingDelete(true)}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-ink-muted transition-colors duration-[120ms] hover:text-danger"
            >
              <TrashIcon />
            </button>
          </div>
          )
        }
      />

      {deleteError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {deleteError}
        </p>
      )}

      {/* Mounted only while confirming. A closed <dialog> is display:none in a browser but is
          still queryable text in jsdom, so leaving it mounted would leak "Delete this duty?"
          into every assertion about the card's contents. */}
      {confirmingDelete && (
      <dialog
        ref={deleteDialogRef}
        data-testid="delete-dialog"
        aria-labelledby="delete-dialog-title"
        onClose={() => setConfirmingDelete(false)}
        // Clicking the backdrop lands on the dialog element itself, never on its children.
        onClick={(e) => {
          if (e.target === deleteDialogRef.current) setConfirmingDelete(false);
        }}
        // `m-auto` is load-bearing, not spacing. A modal <dialog> is centred by the UA's own
        // `margin: auto` against `inset: 0`, and Tailwind's Preflight resets `margin: 0` on
        // every element — which parks it in the top-left corner. Measured at 1200x900 before
        // the fix: box at 0,0 with `margin: 0px`, `position: fixed`, `inset: 0`.
        className="m-auto max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-card p-5 text-ink backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p id="delete-dialog-title" className="text-lg font-semibold text-ink">
              Delete this duty?
            </p>
            {/* Names the duty: a day can now hold more than one, so "delete trip" alone is
                ambiguous once two cards are on screen. */}
            <p className="num text-sm text-ink-muted">
              {firstLeg.flightNo} · {firstLeg.origin} → {legs[legs.length - 1]!.dest}
            </p>
            <p className="text-sm text-ink-muted">{humanDateLabel(isoDate, homeTz)}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="min-h-[48px] rounded border border-edge px-4 py-2 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="confirm-delete"
              disabled={deleting}
              onClick={confirmDelete}
              className="min-h-[48px] rounded border border-danger px-4 py-2 font-medium text-danger transition-colors duration-[120ms] hover:bg-danger/10 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      </dialog>
      )}

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {/* Same flight-number field as the add sheet: airline code as static text, digits
              typed. Editing it re-runs the schedule lookup below - the legs panel underneath
              still shows what's ON the roster right now, so Save's replacement is never a
              surprise. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void entry.handleAutofillSubmit();
            }}
            className="flex flex-col gap-3"
          >
            <div>
              <label htmlFor="card-edit-flightno" className="text-sm text-ink-muted">
                Flight number
              </label>
              <div className="mt-1 flex items-center gap-2 rounded border border-edge bg-raised px-3 py-2 transition-colors duration-[120ms] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent">
                <span className="num text-lg text-ink-muted">{airlinePrefix}</span>
                <input
                  id="card-edit-flightno"
                  data-testid="card-edit-flightno"
                  inputMode="numeric"
                  value={digitsOf(entry.flightNo, airlinePrefix)}
                  onChange={(e) => entry.setFlightNo(airlinePrefix + e.target.value.replace(/\D/g, ""))}
                  className="num w-full bg-transparent text-lg text-ink outline-none focus-visible:outline-none"
                />
              </div>
            </div>

            {entry.resolving && <p className="text-sm text-ink-muted">checking schedule…</p>}
            {entry.lookupMiss && (
              <p role="alert" className="text-sm text-danger">
                unknown flight — try another number
              </p>
            )}
            {entry.error && (
              <p role="alert" className="text-sm text-danger">
                {entry.error}
              </p>
            )}
            {editError && (
              <p role="alert" className="text-sm text-danger">
                {editError}
              </p>
            )}

            <TripLegsPanel trip={trip} />

            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="card-edit-save"
                disabled={!entry.autofillLegs || entry.submitting || entry.resolving}
                className="min-h-[44px] rounded bg-accent px-3 py-2 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                data-testid="card-edit-cancel"
                onClick={() => setExpanded(false)}
                className="min-h-[44px] rounded border border-edge px-3 py-2 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Inside the card, not beside it: the rest belongs to the flight that created it, and
          two stacked cards made one day read as two separate things. */}
      {layoverRest && <CopyLayoverBrief rest={layoverRest} />}
    </div>
  );
}

/**
 * A day's duties. A calendar date can hold more than one — a turnaround in the morning and a
 * standby that evening are two separate trips with their own report times, not legs of one.
 *
 * Each duty gets its own DayDetailCard, so edit and delete stay unambiguous: one card owns one
 * trip, and its own expand/confirm state. That isolation is why stacking beats merging them into
 * a single card with shared controls.
 */
function DayDetail({
  isoDate,
  trips,
  homeTz,
  now,
  layoverRest,
  nextDuty,
  onAdded,
  onChanged,
  readOnly = false,
}: {
  isoDate: string;
  trips: TripWithFlights[];
  homeTz: string;
  /** Threaded down to the status block on each card. */
  now: Date;
  /** The next duty not yet flown, for a day that holds none of its own. */
  nextDuty?: NextDutySummary | null;
  /** The down-route rest this day falls inside, when it does. Belongs to the day rather than to
   * a trip: the middle of a layover has no duty at all, so it cannot hang off a trip card. */
  layoverRest: LayoverRest | null;
  onAdded: (isoDate: string) => void;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [addingAnother, setAddingAnother] = useState(false);
  // Picking a different day must not leave the second-duty form open on it.
  useEffect(() => {
    setAddingAnother(false);
  }, [isoDate]);

  // An empty day is the existing single-card case: DayDetailCard already renders the add form
  // when `trip` is null, so there is no second add path to keep in step.
  if (trips.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <DayDetailCard
          // Remounted per day, so "I asked for the form on THIS layover day" does not follow
          // her onto the next one.
          key={isoDate}
          isoDate={isoDate}
          trip={null}
          homeTz={homeTz}
          now={now}
          layoverRest={layoverRest}
          nextDuty={nextDuty}
          onAdded={onAdded}
          onChanged={onChanged}
          readOnly={readOnly}
        />
      </div>
    );
  }

  return (
    <div data-testid="day-detail" className="flex flex-col gap-3">
      {trips.map((trip, index) => (
        <DayDetailCard
          key={trip.id}
          isoDate={isoDate}
          trip={trip}
          homeTz={homeTz}
          now={now}
          // First card only: a day with a morning turnaround and an evening standby is two
          // cards, and the rest they share must not be printed on both.
          layoverRest={index === 0 ? layoverRest : null}
          onAdded={onAdded}
          onChanged={onChanged}
          readOnly={readOnly}
        />
      ))}

      {readOnly ? null : addingAnother ? (
        <div className="hairline flex flex-col gap-3 rounded-lg border border-edge bg-card p-4">
          <p className="text-sm text-ink-muted">Another duty on {humanDateLabel(isoDate, homeTz)}</p>
          <AddTripForm
            isoDate={isoDate}
            homeTz={homeTz}
            onSubmitted={() => {
              onAdded(isoDate);
              onChanged();
              setAddingAnother(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          data-testid="add-another-duty"
          onClick={() => setAddingAnother(true)}
          className="min-h-[44px] rounded border border-dashed border-edge px-3 py-2 text-sm text-ink-muted transition-colors duration-[120ms] hover:border-accent hover:text-accent"
        >
          + Add another duty
        </button>
      )}
    </div>
  );
}

/** Shown in place of the calendar while `/api/trips` is still in flight. Two blocks sized to
 * roughly match TripsCalendar and the card beneath it (next-duty / day-detail), so the layout
 * doesn't jump when real content lands — same shape-matching approach as SharedViewer's own
 * loading skeleton. motion-reduce disables the pulse rather than just slowing it, per the
 * reduced-motion contract the rest of the app follows (tokens.css's .entrance/.tl-enter). */
function CalendarSkeleton() {
  return (
    <div
      data-testid="calendar-skeleton"
      aria-live="polite"
      aria-busy="true"
      className="flex w-full max-w-xl flex-col gap-4"
    >
      <div className="h-[360px] w-full animate-pulse rounded-lg bg-raised motion-reduce:animate-none" />
      <div className="h-32 w-full animate-pulse rounded-lg bg-raised motion-reduce:animate-none" />
    </div>
  );
}

/** Calendar tab: month grid (trip days marked) + an active-pairing progress card (when a
 * trip spans `now`) + exactly one day card, for the day she tapped or, until she taps one,
 * for today. A trip day expands to its legs + Edit/Delete; an empty day shows the add-trip
 * form (AddTripForm) inline — no "Add trip" button, no bottom sheet, one tap fewer. There is
 * no second list of the same duties — the grid is the overview, and this card is the detail. */
export default function CalendarHome({ now, openTodayToken }: Props) {
  const [trips, setTrips] = useState<TripWithFlights[] | null>(null);
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  // Days added inline, marked on the grid immediately ahead of the refetch each add triggers
  // (cleared once that refetch's own data covers them).
  const [optimisticDays, setOptimisticDays] = useState<Set<string>>(new Set());
  const [crew, setCrew] = useState<CrewMember[]>([]);
  // null = your own roster; a user id = that crew member's, read-only.
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  const nowMs = now.getTime();
  const readOnly = viewingUserId !== null;

  // Roster fetches are racy by nature: switching badges fires a second request while the first
  // is still out, and without a sequence guard a slow /api/trips landing after a fast crew read
  // would paint your own roster under their badge — or theirs under yours.
  const rosterRequest = useRef(0);

  function refetch(userId: string | null = viewingUserId) {
    const seq = ++rosterRequest.current;
    (userId === null ? getTrips() : getCrewTrips(userId))
      .then((loaded) => {
        if (seq === rosterRequest.current) setTrips(loaded);
      })
      .catch(() => {
        if (seq !== rosterRequest.current || userId === null) return;
        // The pairing ended while their roster was open (they revoked, or it expired between
        // the badge render and the tap): the crew read now 404s forever. Fall back to your own
        // roster and re-read the crew list, rather than sitting on the skeleton.
        setViewingUserId(null);
        setSelectedIso(null);
        getCrew()
          .then((res) => setCrew(res.members))
          .catch(() => setCrew([]));
        refetch(null);
      });
    setOptimisticDays(new Set());
  }

  useEffect(() => {
    refetch(null);
    // A crew list is the common case of "empty" — this failing is not worth a visible error,
    // it just means no badges.
    getCrew()
      .then((res) => setCrew(res.members))
      .catch(() => setCrew([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Switching whose roster is on screen. The selected day is dropped: it belongs to the
   * roster being left, and keeping it would open someone else's day in the detail card. */
  function showRosterOf(userId: string | null) {
    if (userId === viewingUserId) return;
    setViewingUserId(userId);
    setSelectedIso(null);
    setTrips(null);
    refetch(userId);
  }

  const badges = <CrewBadges members={crew} viewing={viewingUserId} onSelect={showRosterOf} />;

  /**
   * The zone every calendar day is keyed in — the crew's BASE, not wherever she happens to be.
   *
   * Taken from the earliest leg that departs home base, because that leg's `depTz` is the base
   * airport's own zone. `trips[0]` is not a safe stand-in: the API's order is not chronological
   * and its first leg can depart an outstation.
   *
   * This is one value on purpose. The grid used to be keyed by `nextDuty.depTz` while the day
   * cards were keyed by this, and mid-pairing those are different zones — with the next duty
   * leaving Buenos Aires (UTC-3), EK805's 06:55 Dubai departure keys to the day BEFORE on the
   * grid. The 19th then held no departure and fell through to the layover glyph, so the grid
   * said "· JED" on a day whose own card said "DXB → JED, departs 06:55".
   *
   * A leg that LANDS at base is the second source, and it is not a lesser one: its `arrTz` is
   * the same airport's zone read from the other end. It matters because a roster can genuinely
   * contain no departure from base — she joined a routing down-route, and her only sector is the
   * one home. The old fallback then took whatever leg the API happened to list first and keyed
   * the whole grid to an outstation: a flight landing 00:30 Dubai read as 17:30 the previous day
   * in São Paulo, so the morning she got home was not a day on the calendar at all.
   */
  const allLegs = (trips ?? []).flatMap((trip) => trip.flights);
  const homeTz =
    allLegs
      .filter((leg) => leg.origin === HOME_BASE_IATA)
      .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc))[0]?.depTz ??
    allLegs
      .filter((leg) => leg.dest === HOME_BASE_IATA)
      .sort((a, b) => Date.parse(a.arrUtc) - Date.parse(b.arrUtc))[0]?.arrTz ??
    trips?.[0]?.flights[0]?.depTz ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  // The day the card is about. Nothing picked yet means today — DERIVED, never written into
  // `selectedIso` by an effect.
  //
  // Without a default there was no card at all until she tapped a date, and the first screen
  // stacked the pairing strip on a `next-duty-card` that was a read-only echo of a day and the
  // only surface here that could not be edited or deleted. With one, the app opens on the card
  // a tap would have given her — on a day off too, because the empty-day card names the next
  // duty itself now.
  //
  // The effect that did this instead lost a tap: React flushes passive effects after the
  // commit, so a tap landing between the roster's paint and that flush was overwritten by
  // today. A default cannot race a tap — once `selectedIso` is set, it wins.
  const shownIso = selectedIso ?? localDateKey(now.toISOString(), homeTz);

  // Every trip covering a given local calendar date, by checking each trip's away-day span for
  // that date's month against tripDaysInMonth (mirrors TripsCalendar's own per-day lookup so the
  // day card always matches what the grid renders).
  //
  // Returns a LIST: a date can hold more than one duty — a turnaround in the morning and a
  // standby that evening are separate trips, not legs of one. This used to return the first
  // match and stop, which made any second duty on a day invisible.
  function tripsForDay(iso: string): TripWithFlights[] {
    if (!trips) return [];
    const [yearStr, monthStr] = iso.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    const found: TripWithFlights[] = [];
    for (const trip of trips) {
      const span = calendarSpan([...trip.flights].sort((a, b) => a.legSeq - b.legSeq), HOME_BASE_IATA);
      if (!span) continue;
      const spanDays = tripDaysInMonth([span], year, month, homeTz);
      if (spanDays.has(iso)) found.push(trip);
    }
    // Earliest departure first, so the morning duty reads above the evening one.
    return found.sort((a, b) => {
      const aDep = [...a.flights].sort((x, y) => x.legSeq - y.legSeq)[0]?.depUtc ?? "";
      const bDep = [...b.flights].sort((x, y) => x.legSeq - y.legSeq)[0]?.depUtc ?? "";
      return Date.parse(aDep) - Date.parse(bDep);
    });
  }

  // The down-route rest a date falls inside, walked across EVERY trip rather than the day's own
  // — a real layover sits between two trips of a pairing, so `tripsForDay` cannot see it, and on
  // the middle day it returns nothing at all.
  function layoverRestForDay(iso: string): LayoverRest | null {
    if (!trips) return null;
    return restForDay(layoverRests(trips, HOME_BASE_IATA), iso, homeTz);
  }

  // Selects today, or the next trip-free day after today when today already has a trip — used
  // by the tab bar's center + button. Tracks the LAST SEEN token (initialized to the current
  // value, not 0) so a remount with an already-bumped token (e.g. `key` change from an
  // unrelated trip edit) doesn't spuriously reselect — only an actual change does.
  const lastSeenToken = useRef(openTodayToken);
  useEffect(() => {
    if (openTodayToken === lastSeenToken.current || trips === null) return;
    lastSeenToken.current = openTodayToken;
    // + means "add a trip", which is only ever a thing on your own roster. Viewing a crew
    // member, the day it selected was theirs and read-only, so the button did nothing at all.
    if (viewingUserId !== null) {
      showRosterOf(null);
      return;
    }
    // Simply today. This used to walk forward to the next trip-free day, because a day that
    // already had a duty could not take another one — now that it can, skipping would send you
    // to the wrong date to add the second duty of the day you are looking at.
    setSelectedIso(localDateKey(now.toISOString(), homeTz));
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTodayToken, trips]);

  if (trips === null) {
    return (
      <div className="flex w-full max-w-xl flex-col gap-4">
        {badges}
        <CalendarSkeleton />
      </div>
    );
  }

  const allFlights = trips
    .flatMap((trip) => trip.flights)
    .sort((a, b) => Date.parse(a.reportUtc) - Date.parse(b.reportUtc));
  // "Not landed yet", ordered by report — NOT "report still to come".
  //
  // A duty drops out of its own card the moment she reports for it otherwise. On 1 Sept at
  // 16:46 the app opened on `DXB → CPH · Wed 2 Sept` while she was in the air on EK192, which
  // had reported at 15:50 and lands at 00:55: the one duty she is actually on was the one the
  // card refused to show. Filtering on arrival keeps a duty on screen until it is over.
  const upcoming = allFlights.filter((f) => Date.parse(f.arrUtc) >= nowMs);
  const nextDuty = upcoming[0] ?? null;
  const tripByFlightId = new Map(trips.flatMap((trip) => trip.flights.map((f) => [f.id, trip])));

  // Prepared here because this is where "next" is decided. The route is the whole chain, not the
  // first leg — DXB → SIN → AKL is one duty and naming only its first sector would misdescribe it.
  const nextDutySummary: NextDutySummary | null = (() => {
    if (!nextDuty) return null;
    const owning = tripByFlightId.get(nextDuty.id);
    const ordered = owning ? [...owning.flights].sort((a, b) => a.legSeq - b.legSeq) : [nextDuty];
    const chain = [ordered[0]!.origin, ...ordered.map((l) => l.dest)].filter(
      (stop, i, all) => i === 0 || stop !== all[i - 1],
    );
    return {
      isoDate: localDateKey(ordered[0]!.depUtc, homeTz),
      flightNo: ordered[0]!.flightNo,
      route: chain.join(" → "),
    };
  })();

  if (!nextDuty) {
    return (
      <div className="entrance flex w-full max-w-xl flex-col gap-4">
        {badges}
        <TripsCalendar
          now={now}
          trips={trips}
          homeTz={homeTz}
          onPickDay={setSelectedIso}
          optimisticIsoDates={optimisticDays}
          selectedIso={selectedIso}
        />
        {/* The "No trips yet — add your first" panel that used to stand here is gone. Its
            button did one thing, `setSelectedIso(today)`, and today's card is what renders
            here now — so the panel asked for a tap to reach a screen already on screen, with
            the flight-number box on it. */}
        <div className="w-full text-left">
          <DayDetail
            isoDate={shownIso}
            trips={tripsForDay(shownIso)}
            homeTz={homeTz}
            now={now}
            layoverRest={layoverRestForDay(shownIso)}
            onAdded={(iso) => setOptimisticDays((prev) => new Set(prev).add(iso))}
            onChanged={refetch}
            readOnly={readOnly}
          />
        </div>
      </div>
    );
  }

  const nextDutyTrip = tripByFlightId.get(nextDuty.id) ?? null;
  const legs = nextDutyTrip ? [...nextDutyTrip.flights].sort((a, b) => a.legSeq - b.legSeq) : [nextDuty];
  const firstLeg = legs[0]!;


  // Active pairing: a trip whose first departure has passed and last arrival hasn't (spans
  // `now`). Home base tz = origin tz of the trip's first leg. Ported from the old CrewHome -
  // glance-critical mid-trip status per UX research §2.
  const activePairing = trips
    .map((trip) => {
      const tripLegs = [...trip.flights].sort((a, b) => a.legSeq - b.legSeq);
      const first = tripLegs[0];
      const last = tripLegs[tripLegs.length - 1];
      if (!first || !last) return null;
      const progress = tripProgress(first.depUtc, last.arrUtc, first.depTz, nowMs);
      return progress ? { trip, legs: tripLegs, first, last, progress } : null;
    })
    .find((entry) => entry !== null);

  return (
    <div className="entrance flex w-full max-w-xl flex-col gap-4">
      {badges}
      <TripsCalendar
        now={now}
        trips={trips}
        homeTz={homeTz}
        onPickDay={setSelectedIso}
        optimisticIsoDates={optimisticDays}
        selectedIso={selectedIso}
      />

      {activePairing && (
        <div
          data-testid="pairing-progress-card"
          className="hairline stagger-1 flex flex-col gap-3 rounded-lg border border-edge bg-card p-4"
        >
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-ink">
              Trip · {activePairing.progress.totalDays}{" "}
              {activePairing.progress.totalDays === 1 ? "day" : "days"}
            </p>
            <p className="num text-sm text-ink-muted">
              day {activePairing.progress.currentDay} of {activePairing.progress.totalDays}
            </p>
          </div>

          <p className="num text-sm text-ink-muted">
            {activePairing.legs.map((leg, index) => {
              const prevLeg = activePairing.legs[index - 1];
              const layover = prevLeg ? layoverHours(prevLeg.arrUtc, leg.depUtc) : null;
              return (
                <span key={leg.id}>
                  {layover !== null && ` ····· ${layover.toFixed(0)}h ····· `}
                  {leg.origin} → {leg.dest}
                </span>
              );
            })}
          </p>

          <div className="flex gap-1">
            {Array.from({ length: activePairing.progress.totalDays }, (_, i) => i + 1).map((day) => (
              <div
                key={day}
                className={`h-1.5 flex-1 rounded-full ${
                  day <= activePairing.progress.currentDay ? "bg-accent" : "bg-accent-soft"
                }`}
              />
            ))}
          </div>
        </div>
      )}

      <div className="stagger-2">
        {/* Always a day card. The `next-duty-card` that used to stand here when nothing was
            selected is gone: today is selected on load, and it was the only surface on this
            screen that could not be edited or deleted — a read-only echo of a day. What it
            uniquely answered, "when do I fly next", the empty-day card now answers itself. */}
        <DayDetail
          isoDate={shownIso}
          trips={tripsForDay(shownIso)}
          homeTz={homeTz}
          now={now}
          layoverRest={layoverRestForDay(shownIso)}
          nextDuty={nextDutySummary}
          onAdded={(iso) => setOptimisticDays((prev) => new Set(prev).add(iso))}
          onChanged={refetch}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

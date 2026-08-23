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
import { digitsOf, getAirlinePrefix } from "./lib/airlinePrefix";
import { useAirport } from "./lib/airports";
import { CopyLayoverBrief } from "./CopyLayoverBrief";
import { humanDateLabel } from "./lib/dateLabel";
import { MIN_LAYOVER_FREE_HOURS } from "./lib/layoverBrief";
import { useDestinationSky, type Sky } from "./lib/useSky";
import { HOME_BASE_IATA } from "./lib/homeBase";
import { layoverRests, restForDay, type LayoverRest } from "./lib/layoverBrief";
import TripLegsPanel from "./TripLegsPanel";
import TripsCalendar from "./TripsCalendar";
import { useTripEntry } from "./useTripEntry";

/** Lead time for "Leave home" ahead of report — ported from the old CrewHome's next-duty card
 * (see git history: af7cc4c). */
const LEAVE_HOME_LEAD_MS = 55 * 60 * 1000;

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

type TimelineRow = {
  key: string;
  time: string;
  icon: string;
  iconTone: string;
  label: string;
  sub?: React.ReactNode;
};

/** The full duty detail (design "C"): Leave home -> Report -> (Departs -> Lands) per leg, with a
 * Layover row between legs. Sits below the REPORT/DEP/ARR board rows (TripSummaryLines) rather
 * than replacing them — always on screen for a trip day, no scroll or tap required. The first
 * three rows stagger in at 60/120/180ms (`.tl-enter`, tokens.css) on mount — under reduced
 * motion that class applies no animation at all, so the detail simply renders present. */
function TripTimeline({ legs }: { legs: TripWithFlights["flights"] }) {
  const firstLeg = legs[0]!;
  const leaveHomeUtc = new Date(Date.parse(firstLeg.reportUtc) - LEAVE_HOME_LEAD_MS).toISOString();

  const rows: TimelineRow[] = [
    {
      key: "leave-home",
      time: formatLocal(leaveHomeUtc, firstLeg.depTz),
      icon: "○",
      iconTone: "text-ink-muted",
      label: "Leave home",
    },
    {
      key: "report",
      time: formatLocal(firstLeg.reportUtc, firstLeg.depTz),
      icon: "●",
      iconTone: "text-report",
      label: "Report",
      sub: <StationLine iata={firstLeg.origin} />,
    },
  ];

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
        <p className="num text-sm text-ink-muted">{formatDuration(leg.depUtc, leg.arrUtc)} airborne</p>
      ),
    });
    rows.push({
      key: `lands-${leg.id}`,
      time: formatLocal(leg.arrUtc, leg.arrTz),
      icon: "◌",
      iconTone: "text-ink-muted",
      label: "Lands",
      sub: <StationLine iata={leg.dest} shift={clockShiftHours(leg.depUtc, leg.depTz, leg.arrUtc, leg.arrTz)} />,
    });
  });

  return (
    <div data-testid="duty-timeline" className="mt-4 flex flex-col gap-3">
      {rows.map((row, i) => (
        <div key={row.key} className={["flex items-start gap-3", i < 3 ? `tl-enter tl-enter-${i + 1}` : ""].join(" ")}>
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
  actions,
  showTimeline,
  sky,
}: {
  legs: TripWithFlights["flights"];
  /** The destination's forecast for the landing day, when there is one. The field behind the
   * card carries the feel; this line carries the numbers, because a gradient cannot say 86%. */
  sky?: Sky | null;
  /** Corner controls, rendered in the header row so they never steal width from the board. */
  actions?: React.ReactNode;
  /** Appends the full duty timeline (TripTimeline) below the board rows — used by the
   * day-detail card for a trip day. Omitted for the compact next-duty preview card, which
   * stays board-only. */
  showTimeline?: boolean;
}) {
  const firstLeg = legs[0]!;
  const lastLeg = legs[legs.length - 1]!;
  const routeChain = [legs[0]!.origin, ...legs.map((leg) => leg.dest)].filter(
    (stop, index, all) => index === 0 || stop !== all[index - 1],
  );
  const arrOffset = dayOffset(firstLeg.depUtc, lastLeg.arrUtc, firstLeg.depTz, lastLeg.arrTz);
  // Out of base and back on the same local day: a turnaround. Worth naming, because on the card
  // it otherwise reads as an ordinary duty with an odd route chain — and the ground time at the
  // outstation is transit, which the timeline now says too.
  const isTurnaround =
    firstLeg.origin === HOME_BASE_IATA &&
    lastLeg.dest === HOME_BASE_IATA &&
    localDateKey(firstLeg.depUtc, firstLeg.depTz) === localDateKey(lastLeg.arrUtc, lastLeg.arrTz);

  // Length only earns a place on a pairing that actually spans days — "1 day" is noise.
  const tripDays = new Set(legs.map((leg) => formatLocal(leg.depUtc, leg.depTz, { withDate: true }).slice(0, 6)))
    .size;
  // Weekday + day + month only: the year is never in question on a roster, and the +N on the
  // arrival already says when a red-eye actually lands.
  const depDate = formatLocal(firstLeg.depUtc, firstLeg.depTz, { withDate: true }).split(" ").slice(0, 3).join(" ");
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

      {/* Board rows: label left (small, uppercase, tracked, muted — amber for REPORT since
          that's the one time worth flagging), value right (tabular). Dashed hairlines between
          rows read as the split-flap rule this direction is named for; a justify-between row
          never collides at 390px the way the old rail's centered duration badge did. */}
      <div className="mt-4 flex flex-col divide-y divide-dashed divide-edge">
        <div className="flex items-baseline justify-between py-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-report">Report</span>
          <span className="num text-base text-report">{formatLocal(firstLeg.reportUtc, firstLeg.depTz)}</span>
        </div>
        <div className="flex items-baseline justify-between py-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Dep</span>
          <span className="num text-base text-ink">{formatLocal(firstLeg.depUtc, firstLeg.depTz)}</span>
        </div>
        <div className="flex items-baseline justify-between py-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Arr</span>
          <span className="num text-base text-ink">
            {formatLocal(lastLeg.arrUtc, lastLeg.arrTz)}
            {arrOffset > 0 && <sup className="text-xs text-ink-muted">+{arrOffset}</sup>}
          </span>
        </div>
      </div>

      {duration && <p className="num mt-1.5 text-right text-sm text-ink-muted">{duration}</p>}

      {showTimeline && <TripTimeline legs={legs} />}
    </>
  );
}

/** The card shown below the calendar grid while a day is selected (tap-to-detail), replacing
 * the next-duty card for the duration of the selection. A trip day expands IN PLACE to its
 * legs and a delete control. An empty day shows the add-trip form (AddTripForm) directly —
 * no "Add trip" button and no bottom sheet — remounted (via a key bump) after each successful
 * add so it comes back blank while the parent's refetch flips the card to the trip view. */
function DayDetailCard({
  isoDate,
  trip,
  homeTz,
  layoverRest,
  onAdded,
  onChanged,
  readOnly = false,
}: {
  isoDate: string;
  trip: TripWithFlights | null;
  homeTz: string;
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
        <p className="text-sm text-ink-muted">{humanDateLabel(isoDate, homeTz)} — no duty</p>
        {/* The day in the middle of a layover: no duty, and the one she is most likely to be
            planning. "No duty" alone is true and useless here. */}
        {layoverRest && <CopyLayoverBrief rest={layoverRest} />}
        {readOnly ? null : (
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
      <TripSummaryLines
        sky={sky}
        legs={legs}
        showTimeline
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
        className="max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-card p-5 text-ink backdrop:bg-black/50"
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
  layoverRest,
  onAdded,
  onChanged,
  readOnly = false,
}: {
  isoDate: string;
  trips: TripWithFlights[];
  homeTz: string;
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
          isoDate={isoDate}
          trip={null}
          homeTz={homeTz}
          layoverRest={layoverRest}
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
 * trip spans `now`) + a compact next-duty card. Single tap on any day SELECTS it, showing its
 * detail in place of the next-duty card: a trip day expands to its legs + Edit/Delete, an
 * empty day shows the add-trip form (AddTripForm) inline — no "Add trip" button, no bottom
 * sheet, one tap fewer. There is no second list of the same duties — the grid is the
 * overview, and this card is the detail. */
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
   */
  const homeTz =
    (trips ?? [])
      .flatMap((trip) => trip.flights)
      .filter((leg) => leg.origin === HOME_BASE_IATA)
      .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc))[0]?.depTz ??
    trips?.[0]?.flights[0]?.depTz ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

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
      const legs = [...trip.flights].sort((a, b) => a.legSeq - b.legSeq);
      const first = legs[0];
      const last = legs[legs.length - 1];
      if (!first || !last) continue;
      const spanDays = tripDaysInMonth([{ firstDepUtc: first.depUtc, lastArrUtc: last.arrUtc }], year, month, homeTz);
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

  // The next duty's final destination, resolved here rather than beside the preview card
  // because it drives a hook and the card sits past two early returns.
  const previewLastLeg = (() => {
    if (!trips) return null;
    const next = trips
      .flatMap((trip) => trip.flights)
      .filter((leg) => Date.parse(leg.arrUtc) >= nowMs)
      .sort((a, b) => Date.parse(a.depUtc) - Date.parse(b.depUtc))[0];
    if (!next) return null;
    const owning = trips.find((trip) => trip.flights.some((leg) => leg.id === next.id));
    const ordered = owning ? [...owning.flights].sort((a, b) => a.legSeq - b.legSeq) : [next];
    return ordered[ordered.length - 1] ?? null;
  })();
  const nextDutySky = useDestinationSky(
    previewLastLeg?.dest ?? "",
    previewLastLeg?.arrUtc ?? "",
    previewLastLeg?.arrTz ?? "UTC",
  );

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
  const upcoming = allFlights.filter((f) => Date.parse(f.reportUtc) >= nowMs);
  const nextDuty = upcoming[0] ?? null;
  const tripByFlightId = new Map(trips.flatMap((trip) => trip.flights.map((f) => [f.id, trip])));

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
        {selectedIso ? (
          <div className="w-full text-left">
            <DayDetail
              isoDate={selectedIso}
              trips={tripsForDay(selectedIso)}
              homeTz={homeTz}
              layoverRest={layoverRestForDay(selectedIso)}
              onAdded={(iso) => setOptimisticDays((prev) => new Set(prev).add(iso))}
              onChanged={refetch}
              readOnly={readOnly}
            />
          </div>
        ) : readOnly ? (
          <p className="text-center text-ink-muted">Nothing on this roster yet</p>
        ) : (
          // trips stays [] until the first add's own refetch resolves - once a day has been
          // marked optimistically, this "no trips yet" empty state + its CTA would otherwise
          // stay stale, contradicting what the grid above already shows. In practice the day
          // is always selected by the time an add happens (the form lives on its detail card),
          // so this branch never actually races the optimistic mark - kept as a guard anyway.
          optimisticDays.size === 0 && (
            <div className="flex flex-col items-center gap-4 text-center">
              <p className="text-ink-muted">No trips yet — add your first</p>
              <button
                type="button"
                onClick={() => setSelectedIso(localDateKey(now.toISOString(), homeTz))}
                className="rounded bg-accent px-3 py-2 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98]"
              >
                Add your first trip
              </button>
            </div>
          )
        )}
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
            <p className="text-sm text-ink">Trip · {activePairing.progress.totalDays} days</p>
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

      {selectedIso ? (
        <div className="stagger-2">
          <DayDetail
            isoDate={selectedIso}
            trips={tripsForDay(selectedIso)}
            homeTz={homeTz}
            layoverRest={layoverRestForDay(selectedIso)}
            onAdded={(iso) => setOptimisticDays((prev) => new Set(prev).add(iso))}
            onChanged={refetch}
            readOnly={readOnly}
          />
        </div>
      ) : (
        <button
          type="button"
          data-testid="next-duty-card"
          // Selects the duty's day — this day already has a trip, so its own detail card
          // (not an add form) is what shows and edits it.
          onClick={() => setSelectedIso(localDateKey(firstLeg.depUtc, firstLeg.depTz))}
          className="hairline stagger-2 flex flex-col gap-1 rounded-lg border border-edge bg-card p-4 text-left transition-colors duration-[120ms] hover:bg-raised"
        >
          <TripSummaryLines legs={legs} sky={nextDutySky} showTimeline />
        </button>
      )}
    </div>
  );
}

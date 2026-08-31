import { useLayoutEffect, useRef, useState } from "react";
import { localDateKey, monthGrid, tripDaysInMonth } from "@danyeowa/shared";
import type { TripWithFlights } from "./api";
import { dutyDayMarks, type DayKind } from "./lib/dayMarks";
import { HOME_BASE_IATA } from "./lib/homeBase";
import { awaySpans, calendarSpan } from "./lib/dayMarks";

type Props = {
  now: Date;
  trips: TripWithFlights[];
  homeTz: string;
  /** Called for ANY day tap — past or future, empty or with a duty on it. The caller owns
   * select-vs-open-sheet semantics. */
  onPickDay: (isoDate: string) => void;
  /** "picker": pure date-picker mode for the add-trip stepper - no trip markers, no open-trip
   * behavior. Nothing passes this today; the inline add form replaced the stepper. */
  mode?: "picker";
  /** ISO dates added this rapid-entry session but not yet reflected in `trips` (no refetch
   * happened yet) — marked on the grid like a trip day, but tapping still opens the add flow
   * since there's no trip object for them yet. */
  optimisticIsoDates?: ReadonlySet<string>;
  /** Currently selected day (tap-to-detail) - rendered with a stronger, filled ring distinct
   * from today's outline ring. Not used in picker mode. */
  selectedIso?: string | null;
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Direction at a glance: away from base, back to base, out-and-back, outstation hop, slip. */
const DAY_GLYPH: Record<DayKind, string> = {
  outbound: "↗",
  return: "↙",
  turnaround: "⇄",
  sector: "→",
  arrives: "↙",
  layover: "·",
};

/** Colour rides on the GLYPH, not the station code: `accent` on `accent-soft` measures 3.97:1
 * in light mode, under the 4.5:1 text minimum, while a glyph is a non-text graphic held to
 * 3:1. The code itself stays `text-ink` (14.7:1 light / 11.1 dark), so the pair is legible and
 * direction is still carried by shape as well as colour. */
const DAY_TONE: Record<DayKind, string> = {
  outbound: "text-accent",
  return: "text-ink",
  turnaround: "text-accent",
  sector: "text-ink-muted",
  arrives: "text-ink",
  layover: "text-ink-muted",
};

const DAY_LABEL: Record<DayKind, string> = {
  outbound: "outbound to",
  return: "return from",
  turnaround: "turnaround via",
  sector: "sector to",
  arrives: "arrives at",
  layover: "layover at",
};
// Swipe thresholds. 50px of horizontal travel rules out an accidental brush; the 1.5x
// horizontal/vertical ratio rejects a vertical scroll that happens to also drift >50px sideways
// (a straight-down drag on a phone is rarely perfectly vertical). Pointer Events, not touch-only,
// so a trackpad drag works too and the gesture is testable without a touch-emulating harness.
const SWIPE_MIN_DISTANCE = 50;
const SWIPE_DIRECTIONAL_RATIO = 1.5;
// Well under SWIPE_MIN_DISTANCE: a drag that falls short of a real swipe should still cancel the
// tap it would otherwise leave behind, so releasing mid-gesture never also selects a day.
const TAP_CANCEL_DISTANCE = 10;
// The settle after a release. --ease-snap is the token the rest of the app uses for "arrives and
// stops" motion; 480ms (was 320ms — too quick to read as a deliberate arrival, closer to a cut)
// gives the swipe enough travel time to register at phone width without feeling slow.
const SLIDE_TRANSITION = "transform 480ms var(--ease-snap)";
// The track is a flex row whose three panels each take its full width and overflow it, so the
// track's own box stays exactly one panel wide. Percentages in `translate` resolve against that
// box — which is why centring the middle panel is -100%, not -33.33%. Measured, not assumed: at
// -33.33% the calendar sat two thirds of a panel off, showing mostly the previous month.
const TRACK_BASE = "translate3d(-100%, 0, 0)";
const trackOffset = (px: number) => `translate3d(calc(-100% + ${px}px), 0, 0)`;

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Month arithmetic that rolls the year, so the carousel's neighbours work across December. */
function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export default function TripsCalendar({
  now,
  trips,
  homeTz,
  onPickDay,
  mode,
  optimisticIsoDates,
  selectedIso,
}: Props) {
  const isPicker = mode === "picker";
  // "Today" and the initial view month must use the home-base LOCAL date, not the UTC date -
  // they can differ by a day near midnight in tzs far from UTC (see localDateKey).
  const today = localDateKey(now.toISOString(), homeTz);
  const [todayYear, todayMonthStr] = today.split("-");
  const [viewYear, setViewYear] = useState(Number(todayYear));
  const [viewMonth, setViewMonth] = useState(Number(todayMonthStr)); // 1-12
  const tripSpans = isPicker
    ? []
    : trips
        .map((trip) => {
          const span = calendarSpan(
            [...trip.flights].sort((a, b) => a.legSeq - b.legSeq),
            HOME_BASE_IATA,
          );
          return span ? { trip, ...span } : null;
        })
        .filter(
          (
            entry,
          ): entry is {
            trip: TripWithFlights;
            firstDepUtc: string;
            endUtc: string;
          } => entry !== null,
        );

  /** Everything one rendered month needs. Every mark here is month-scoped, so the neighbours the
   * carousel shows mid-swipe each need their own build — none of it can be hoisted out. */
  function buildMonth(year: number, month: number) {
    const grid = monthGrid(year, month, homeTz);
    // Two sources, unioned. Per-trip spans are what the calendar has always marked; the
    // base-to-base away spans add the days between two trips of one pairing — the layover in
    // Buenos Aires that belongs to neither EK247 nor EK248 and used to read as a day at home.
    // Union, not replacement: a roster the walk cannot interpret still marks everything the
    // per-trip spans marked. The one day both sources now deliberately give up is the morning a
    // red-eye lands back at base — she is home for all of it, and marking it said otherwise.
    const spans = [
      ...tripSpans.map(({ firstDepUtc, endUtc }) => ({ firstDepUtc, endUtc })),
      ...awaySpans(
        tripSpans.map(({ trip }) => trip),
        HOME_BASE_IATA,
      ),
    ];
    // A month grid carries its neighbours' edge days: the first week of September is drawn in
    // August's grid, and the last days of July in it too. Marking only the RENDERED month left
    // those cells blank on days the crew member was still away — EK192 lands at base on 1 Sep
    // and August's grid showed the band stopping dead at the 31st. Mark the neighbours as well
    // and let the grid use whatever it happens to be showing. The band's own joining logic
    // reads `dayMarks` and never `inMonth`, so it now carries across the month edge by itself.
    const before = shiftMonth(year, month, -1);
    const after = shiftMonth(year, month, 1);
    const dayMarks = new Map([
      ...tripDaysInMonth(spans, before.year, before.month, homeTz),
      ...tripDaysInMonth(spans, after.year, after.month, homeTz),
      ...tripDaysInMonth(spans, year, month, homeTz),
    ]);
    // Direction glyphs come from the real trip days only: an optimistic day has no legs yet, and
    // the layover fallback would otherwise label it with a station from some earlier trip.
    const dutyMarks = dutyDayMarks(
      tripSpans.map(({ trip }) => trip),
      homeTz,
      HOME_BASE_IATA,
      dayMarks.keys(),
    );

    // Scoped to the dates this grid actually draws rather than to the month, for the same
    // reason: a day added into the trailing week is on screen and should look added.
    const drawn = new Set(grid.flat().map((cell) => cell.iso));
    for (const iso of optimisticIsoDates ?? []) {
      if (drawn.has(iso) && !dayMarks.has(iso)) dayMarks.set(iso, "away");
    }

    return { year, month, grid, dayMarks, dutyMarks };
  }

  const previous = shiftMonth(viewYear, viewMonth, -1);
  const next = shiftMonth(viewYear, viewMonth, 1);
  const panels = [
    buildMonth(previous.year, previous.month),
    buildMonth(viewYear, viewMonth),
    buildMonth(next.year, next.month),
  ];

  // Swipe state lives in refs, not useState — it's read/written only inside pointer handlers on
  // the same render, never needs to trigger a re-render itself. The track's transform is written
  // straight to the DOM for the same reason: a re-render per pointermove would put 126 day cells
  // through React on every frame of the drag.
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Set once a gesture has moved past TAP_CANCEL_DISTANCE; consumed (and reset) by
  // handleGridClickCapture so a dragged release never also fires the day button underneath it.
  const dragMoved = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  // Where the settle animation should start from, in px, once the new month has rendered. Set by
  // whatever triggered the change (a swipe, a ‹ › tap) and consumed by the layout effect below.
  const slideFrom = useRef<number | null>(null);

  const panelWidth = () => trackRef.current?.offsetWidth ?? 0;

  /** Committing the month change and animating it are deliberately separate: state lands
   * synchronously on release, and the animation is replayed *afterwards* from where the finger
   * left off. Waiting on `transitionend` to commit would make the month depend on a CSS
   * transition running at all — which it doesn't under jsdom, or reduced motion, or a
   * background tab. */
  useLayoutEffect(() => {
    const track = trackRef.current;
    const from = slideFrom.current;
    slideFrom.current = null;
    if (!track || from === null) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      track.style.transition = "none";
      track.style.transform = TRACK_BASE;
      return;
    }

    // Two writes in one frame collapse into the last one, so the browser would render only the
    // end state and animate nothing. Reading offsetWidth forces the first to be committed.
    track.style.transition = "none";
    track.style.transform = trackOffset(from);
    void track.offsetWidth;
    track.style.transition = SLIDE_TRANSITION;
    track.style.transform = TRACK_BASE;
  }, [viewYear, viewMonth]);

  function handlePointerDown(e: React.PointerEvent) {
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragMoved.current = false;
    // Kill any settle still in flight so the finger takes over from exactly where it is.
    if (trackRef.current) trackRef.current.style.transition = "none";
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (
      Math.abs(dx) > TAP_CANCEL_DISTANCE ||
      Math.abs(dy) > TAP_CANCEL_DISTANCE
    ) {
      dragMoved.current = true;
    }
    // Only track horizontally once the gesture has declared itself, so the grid doesn't creep
    // sideways during a straight-down page scroll.
    if (!trackRef.current || Math.abs(dx) <= Math.abs(dy)) return;
    // Clamped to one panel: past that there is nothing rendered to show but blank track.
    const width = panelWidth();
    trackRef.current.style.transform = trackOffset(
      Math.max(-width, Math.min(width, dx)),
    );
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    dragStart.current = null;

    const isSwipe =
      Math.abs(dx) > SWIPE_MIN_DISTANCE &&
      Math.abs(dx) > Math.abs(dy) * SWIPE_DIRECTIONAL_RATIO;
    if (!isSwipe) return settleBack();

    const width = panelWidth();
    const clamped = Math.max(-width, Math.min(width, dx));
    // The committed month re-renders centred, so the settle has to start from where the panel
    // already is on screen: one panel further along, plus however far the finger carried it.
    if (dx < 0) {
      slideFrom.current = clamped + width;
      goNextMonth();
    } else {
      slideFrom.current = clamped - width;
      goPrevMonth();
    }
  }

  /** A drag that didn't earn a month change — or was cancelled by the browser taking over the
   * gesture — glides back to centre rather than snapping. */
  function settleBack() {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = SLIDE_TRANSITION;
    track.style.transform = TRACK_BASE;
  }

  function handlePointerCancel() {
    dragStart.current = null;
    settleBack();
  }

  // Capture phase runs before the day button's own onClick (bubble phase), so this swallows the
  // click a swipe leaves in its wake before it ever reaches the button.
  function handleGridClickCapture(e: React.MouseEvent) {
    if (dragMoved.current) {
      e.stopPropagation();
      dragMoved.current = false;
    }
  }

  /** ‹ › taps get the same travel as a swipe — the arrows and the gesture are the same move. */
  function stepMonth(delta: -1 | 1) {
    slideFrom.current = delta * panelWidth();
    if (delta === 1) goNextMonth();
    else goPrevMonth();
  }

  function goPrevMonth() {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function goNextMonth() {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  // Every day is open now, past included, so the tap handler is `onPickDay` itself — see the
  // note on `disabled` below for why the forward-only rule went.

  return (
    // w-full, not shrink-to-fit: the grid is dropped into both a stretched column (trips) and
    // an `items-center` one (empty state), and without it the two render at different widths.
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          data-testid="calendar-prev"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
          className="min-h-[44px] min-w-[44px] rounded border border-edge px-2 py-1 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
        >
          ‹
        </button>
        <p
          data-testid="calendar-month"
          className="text-sm font-medium text-ink"
        >
          {MONTH_LABELS[viewMonth - 1]} {viewYear}
        </p>
        <button
          type="button"
          data-testid="calendar-next"
          onClick={() => stepMonth(1)}
          aria-label="Next month"
          className="min-h-[44px] min-w-[44px] rounded border border-edge px-2 py-1 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs uppercase tracking-wide text-ink-muted">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      {/* The three-month carousel. gap-2 (8px), not gap-1: adjacent tap targets need 8px of
          separation, and 7 cells plus six 8px gaps still leaves 44px cells at a 390px viewport.
          touch-pan-y: the browser keeps owning vertical scrolling outright (we never
          preventDefault on it) - horizontal movement is left free for the pointer handlers
          above to read as a swipe.

          Both neighbours are rendered so a drag reveals real days rather than blank track. They
          are `inert`, so they are out of the tab order and out of the accessibility tree while
          off-screen — otherwise tabbing would wander into a month nobody can see. */}
      <div
        data-testid="calendar-grid"
        className="touch-pan-y overflow-hidden"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClickCapture={handleGridClickCapture}
      >
        <div
          ref={trackRef}
          className="flex will-change-transform"
          style={{ transform: TRACK_BASE }}
        >
          {panels.map((panel, index) => {
            const isCurrent = index === 1;
            return (
              <div
                key={`${panel.year}-${panel.month}`}
                inert={!isCurrent}
                className="grid w-full shrink-0 grid-cols-7 gap-2"
              >
                {panel.grid.flat().map((cell, cellIndex, cells) => {
                  const isToday = cell.iso === today;
                  const isSelected = cell.iso === selectedIso;
                  const isPast = cell.iso < today;
                  const mark = panel.dayMarks.get(cell.iso);
                  const hasTrip = mark !== undefined;
                  const duty = panel.dutyMarks.get(cell.iso);
                  // No day is closed any more. A past day with nothing on it used to be inert,
                  // which is fine for a date picker choosing a flight to come and wrong for a
                  // roster: a duty is usually typed up after it is flown, so its day is already
                  // behind you. Nothing downstream ever objected — the schedule lookup does not
                  // read the direction of the date, `/api/trips` stores any `depUtc`, and both
                  // alert scans search forward from now, so a past duty simply never matches
                  // them. The one thing the rule reliably did was strand a correction: a
                  // wrongly-dated pairing, once deleted, could not be entered again.
                  // Past days stay dimmed (`opacity-60`), because "behind you" is still worth
                  // seeing — they are just no longer unreachable.

                  // A run of away days is drawn as ONE band, not as neighbouring boxes that
                  // happen to share a colour: inner corners square off and the 0.5rem grid gap is
                  // bridged, so a week away reads as a single object. Runs break at the week edge
                  // (column 0 and 6) because a band cannot cross a row — and only there now:
                  // `dayMarks` covers the neighbouring months' edge days too, so a run that
                  // crosses into the next month stays one object.
                  const column = cellIndex % 7;
                  const joinsLeft =
                    hasTrip &&
                    column > 0 &&
                    panel.dayMarks.has(cells[cellIndex - 1]!.iso);
                  const joinsRight =
                    hasTrip &&
                    column < 6 &&
                    panel.dayMarks.has(cells[cellIndex + 1]!.iso);
                  const corners = !hasTrip
                    ? "rounded-lg"
                    : joinsLeft && joinsRight
                      ? "rounded-none"
                      : joinsLeft
                        ? "rounded-l-none rounded-r-lg"
                        : joinsRight
                          ? "rounded-l-lg rounded-r-none"
                          : "rounded-lg";

                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      // Only the centre panel is addressable: a month grid carries its neighbours'
                      // edge days too, so all three panels together repeat some ISO dates, and a
                      // duplicated test id silently breaks every getByTestId that uses one.
                      data-testid={
                        isCurrent ? `calendar-day-${cell.iso}` : undefined
                      }
                      aria-label={
                        duty
                          ? `${cell.day} ${DAY_LABEL[duty.kind]} ${duty.code}`
                          : undefined
                      }
                      aria-current={isToday ? "date" : undefined}
                      aria-pressed={isSelected}
                      onClick={() => onPickDay(cell.iso)}
                      className={[
                        "relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 border py-2 transition-[background-color,border-color,transform] duration-[120ms]",
                        corners,
                        hasTrip
                          ? "border-transparent bg-accent-soft"
                          : "border-edge",
                        // Selected (tap-to-detail) gets a stronger, filled ring - visually distinct
                        // from today's plain outline ring so both can be told apart when they coincide.
                        // Today no longer takes a ring: it was the same colour and shape as the
                        // selected ring, one pixel apart, so the two were indistinguishable. Today
                        // now marks the NUMBER (see below) and selection marks the CELL, which
                        // means they can also both be true at once and still be read.
                        isSelected
                          ? "ring-2 ring-accent ring-offset-1 ring-offset-ground"
                          : "",
                        !cell.inMonth ? "opacity-40" : "",
                        isPast && !hasTrip ? "opacity-60" : "",
                        // Press feedback: transform only, so a pressed cell never nudges its neighbours.
                        "hover:bg-raised active:scale-[0.96]",
                      ].join(" ")}
                    >
                      {joinsRight ? (
                        // Fills the grid's 0.5rem gap so the band is continuous. Sits outside the
                        // button's box on purpose; pointer-events-none keeps the neighbouring day
                        // clickable right up to its own edge.
                        <span
                          aria-hidden="true"
                          // Sized past the gap on every side: an absolutely positioned child is
                          // laid out against the PADDING box, so inset-y-0 stops 1px short of the
                          // painted background at top and bottom and leaves a hairline seam. The
                          // overlap onto both neighbours is the same colour, so it is invisible.
                          className="pointer-events-none absolute -inset-y-px left-full w-[calc(0.5rem+2px)] bg-accent-soft"
                        />
                      ) : null}
                      <span
                        className={[
                          "num flex h-6 min-w-6 items-center justify-center px-1 text-sm",
                          isToday
                            ? "rounded-full bg-today font-semibold text-ground"
                            : "text-ink",
                        ].join(" ")}
                      >
                        {cell.day}
                      </span>
                      {duty ? (
                        <span
                          data-testid={
                            isCurrent ? `day-mark-${cell.iso}` : undefined
                          }
                          className="num flex items-center gap-px text-xs leading-none text-ink"
                        >
                          <span
                            aria-hidden="true"
                            className={DAY_TONE[duty.kind]}
                          >
                            {DAY_GLYPH[duty.kind]}
                          </span>
                          {duty.code}
                        </span>
                      ) : (
                        // Optimistically added day: marked, but the legs haven't been refetched yet.
                        hasTrip && (
                          <span
                            className="h-1 w-3 rounded-full bg-accent"
                            aria-hidden="true"
                          />
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

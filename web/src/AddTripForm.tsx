import { useEffect, useRef, useState } from "react";
import { addDaysIso } from "@danyeowa/shared";
import { digitsOf, getAirlinePrefix } from "./lib/airlinePrefix";
import { humanDateLabel } from "./lib/dateLabel";
import { useTripEntry } from "./useTripEntry";
import type { AutofillLegDraft, UseTripEntryReturn } from "./useTripEntry";

/** Muted "+ add flight" control shown under the preview card while previewing a single
 * flight (hidden once a flight is already appended — the ✕ on the appended card is the only
 * way back to single-flight state). Tapping it reveals a small inline flight-no input; Enter
 * or the "add" button fires the second lookup via `entry.appendFlight`. A lookup miss shows
 * an inline muted error under the input — appended flights are schedule-known only, no
 * manual-mode fallback (manual turnarounds remain possible via the pre-existing multi-leg
 * manual path). */
function AppendFlightControl({ entry, airlinePrefix }: { entry: UseTripEntryReturn; airlinePrefix: string }) {
  const [expanded, setExpanded] = useState(false);
  const [digits, setDigits] = useState("");
  const value = airlinePrefix + digits;

  if (!expanded) {
    return (
      <button
        type="button"
        data-testid="append-flight"
        onClick={() => setExpanded(true)}
        className="w-fit text-sm text-ink-muted underline transition-colors duration-[120ms] hover:text-ink"
      >
        + add flight
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 rounded border border-edge bg-card px-2 py-1 transition-colors duration-[120ms] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent">
          <span className="num text-ink-muted">{airlinePrefix}</span>
          <input
            data-testid="append-flightno-input"
            autoFocus
            inputMode="numeric"
            value={digits}
            onChange={(e) => setDigits(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void entry.appendFlight(value);
              }
            }}
            placeholder="098"
            className="num w-16 bg-transparent text-ink outline-none focus-visible:outline-none"
          />
        </span>
        <button
          type="button"
          onClick={() => void entry.appendFlight(value)}
          className="min-h-[44px] rounded border border-edge px-3 py-1 text-sm text-ink transition-colors duration-[120ms] hover:border-ink-muted"
        >
          Add
        </button>
      </div>
      {entry.appendLookupMiss && (
        <p className="text-sm text-ink-muted">unknown flight — try another number</p>
      )}
    </div>
  );
}

/** Empty-day content: flight-no -> autofill preview -> "Add to roster", with an inline
 * manual fallback on a lookup miss. Driven entirely by useTripEntry. Renders directly on the
 * day-detail card (Plan 11: no more "Add trip" button, no bottom sheet) — a successful save
 * fires `onSubmitted` and the caller remounts this component (a `key` bump) so it comes back
 * showing a blank flight-no field while the parent's own refetch brings the new trip in and
 * flips the card over to the trip view. */
export default function AddTripForm({
  isoDate,
  homeTz,
  onSubmitted,
}: {
  isoDate: string;
  homeTz: string;
  /** Fires once, right after a successful save (autofill or manual). */
  onSubmitted: () => void;
}) {
  const flightNoInputRef = useRef<HTMLInputElement>(null);
  const pickedDate = isoDate;
  const pickedDateLabel = humanDateLabel(isoDate, homeTz);
  const [airlinePrefix] = useState(getAirlinePrefix);

  // One flight per day is the norm, and a turnaround's second leg is appended to this same
  // preview before saving (see AppendFlightControl) — so a save ends the interaction here; the
  // caller (DayDetailCard) remounts this form fresh and refetches.
  const entry = useTripEntry({
    pickedDate,
    homeTz,
    onSubmitted: () => onSubmitted(),
  });

  useEffect(() => {
    if (entry.mode === "flightno") flightNoInputRef.current?.focus();
  }, [entry.mode]);

  if (entry.mode === "flightno") {
    return (
      <div className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            entry.requestSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <label htmlFor="flightno-input" className="text-sm text-ink-muted">
            Flight number
          </label>
          {/* The airline code is a setting, not something to retype on every entry — it is
              rendered as a fixed adornment and only the digits are typed. The value handed to
              the lookup is still the whole flight number. */}
          <div className="flex items-center gap-2 rounded border border-edge bg-raised px-3 py-2 transition-colors duration-[120ms] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent">
            <span className="num text-lg text-ink-muted">{airlinePrefix}</span>
            <input
              id="flightno-input"
              data-testid="flightno-input"
              ref={flightNoInputRef}
              autoFocus
              inputMode="numeric"
              value={digitsOf(entry.flightNo, airlinePrefix)}
              onChange={(e) => entry.setFlightNo(airlinePrefix + e.target.value.replace(/\D/g, ""))}
              placeholder="412"
              className="num w-full bg-transparent text-lg text-ink outline-none focus-visible:outline-none"
            />
          </div>

          {/* Rendered as soon as the flight number matches the pattern - not gated on the
              lookup having resolved, so the crew can press Add without waiting it out (the
              preview card itself still only appears once autofillLegs arrives). */}
          {entry.flightNoValid && (() => {
            const preview = entry.autofillLegs && entry.autofillFlightNo ? entry.autofillLegs : null;
            const outboundLegs = preview ? preview.filter((leg) => leg.flightNo === entry.autofillFlightNo) : [];
            const appendedLegs = preview && entry.appendedFlightNo
              ? preview.filter((leg) => leg.flightNo === entry.appendedFlightNo)
              : [];
            const renderLegFields = (leg: AutofillLegDraft, index: number) => {
              // A multi-leg flight walks the date forward (see legDatesFromPicked), and
              // choosing a boarding point re-anchors the whole routing around it — so the
              // resolved date has to be visible per leg, not just implied by the picked date.
              const arrDate = addDaysIso(leg.depDate, leg.dayOffset);
              return (
                <div key={leg.legSeq} className="flex flex-col gap-2 border-t border-edge pt-3 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <p className="text-ink">
                      {leg.origin} → {leg.dest}
                    </p>
                    <p data-testid="autofill-dep-date" className="text-sm text-ink-muted">
                      {humanDateLabel(leg.depDate, homeTz)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <label htmlFor={`autofill-dep-${leg.legSeq}`} className="text-sm text-ink-muted">
                      Dep
                    </label>
                    <input
                      id={`autofill-dep-${leg.legSeq}`}
                      data-testid="autofill-dep"
                      type="time"
                      value={leg.depTime}
                      onChange={(e) => entry.updateAutofillLeg(index, { depTime: e.target.value })}
                      className="num min-w-[5.5rem] rounded border border-edge bg-card px-2 py-1 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
                    />
                    <label htmlFor={`autofill-arr-${leg.legSeq}`} className="text-sm text-ink-muted">
                      Arr
                    </label>
                    <span className="inline-flex items-center gap-1">
                      <input
                        id={`autofill-arr-${leg.legSeq}`}
                        data-testid="autofill-arr"
                        type="time"
                        value={leg.arrTime}
                        onChange={(e) => entry.updateAutofillLeg(index, { arrTime: e.target.value })}
                        className="num min-w-[5.5rem] rounded border border-edge bg-card px-2 py-1 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
                      />
                      {/* Only shown when the arrival actually lands on a different calendar day
                          than departure — replaces the old bare "+1" superscript now that the
                          real date is on screen and would make the two redundant together. */}
                      {arrDate !== leg.depDate && (
                        <span data-testid="autofill-arr-date" className="text-sm text-ink-muted">
                          {humanDateLabel(arrDate, homeTz)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            };

            return (
              <>
                {preview && (
                  <div data-testid="autofill-card" className="flex flex-col gap-3 rounded border border-edge bg-raised p-4">
                    {outboundLegs.map((leg, index) => renderLegFields(leg, index))}
                    <p className="text-sm text-ink-muted">times from schedule — edit if your roster differs</p>
                  </div>
                )}

                {/* The other half of the same question, and the one that decides what the picked
                    date means. A roster dates a duty by the sector flown: "26 Aug EK248" from
                    someone joining at Rio is the RIO departure. Read as leg 0's date it put the
                    whole pairing a day late. Choosing here re-dates the routing around it. */}
                {preview && preview.length > 1 && (
                  <div
                    data-testid="boarding-point"
                    className="flex flex-col gap-2 rounded border border-edge bg-raised p-4"
                  >
                    <p className="text-ink">Where do you get on?</p>
                    <div className="flex flex-wrap gap-2">
                      {preview.map((leg, i) => {
                        const chosen = (entry.boardingLegIndex ?? 0) === i;
                        return (
                          <button
                            key={leg.legSeq}
                            type="button"
                            data-testid={`boarding-${leg.origin}`}
                            aria-pressed={chosen}
                            onClick={() => entry.setBoardingLeg(i)}
                            className={[
                              "num min-h-[44px] rounded border px-3 py-2 transition-colors duration-[120ms]",
                              chosen
                                ? "border-accent bg-accent-soft text-accent"
                                : "border-edge text-ink-muted hover:border-ink-muted",
                            ].join(" ")}
                          >
                            {leg.origin}
                          </button>
                        );
                      })}
                    </div>
                    {(entry.boardingLegIndex ?? 0) > 0 && (
                      <p data-testid="boarding-note" className="text-sm text-ink-muted">
                        {pickedDateLabel} is read as your {preview[entry.boardingLegIndex ?? 0]!.origin}{" "}
                        departure. The sectors before it are how the aircraft got there.
                      </p>
                    )}
                  </div>
                )}

                {/* A multi-sector flight number is one aircraft routing, not one crew duty — EK205
                    is DXB→MXP→JFK and the crew can change at Milan. Only shown when there is
                    actually a choice to make. */}
                {preview && preview.length > 1 && (
                  <div
                    data-testid="final-destination"
                    className="flex flex-col gap-2 rounded border border-edge bg-raised p-4"
                  >
                    <p className="text-ink">Where do you get off?</p>
                    <div className="flex flex-wrap gap-2">
                      {preview.map((leg, i) => {
                        const chosen = (entry.finalLegIndex ?? preview.length - 1) === i;
                        return (
                          <button
                            key={leg.legSeq}
                            type="button"
                            data-testid={`final-dest-${leg.dest}`}
                            aria-pressed={chosen}
                            onClick={() => entry.setFinalLegIndex(i)}
                            className={[
                              "num min-h-[44px] rounded border px-3 py-2 transition-colors duration-[120ms]",
                              chosen
                                ? "border-accent bg-accent-soft text-accent"
                                : "border-edge text-ink-muted hover:border-ink-muted",
                            ].join(" ")}
                          >
                            {leg.dest}
                          </button>
                        );
                      })}
                    </div>
                    {(entry.finalLegIndex ?? preview.length - 1) < preview.length - 1 && (
                      <p data-testid="continuation-note" className="text-sm text-ink-muted">
                        The rest is saved as the aircraft's onward routing — it won't count as your
                        landing time.
                      </p>
                    )}
                  </div>
                )}

                {appendedLegs.length > 0 && (
                  <div data-testid="appended-card" className="flex flex-col gap-3 rounded border border-edge bg-raised p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-ink-muted">+ {entry.appendedFlightNo}</p>
                      <button
                        type="button"
                        data-testid="remove-appended"
                        aria-label="Remove appended flight"
                        onClick={entry.removeAppendedFlight}
                        className="min-h-[44px] min-w-[44px] rounded border border-edge px-2 text-ink-muted transition-colors duration-[120ms] hover:border-ink-muted"
                      >
                        ✕
                      </button>
                    </div>
                    {appendedLegs.map((leg, index) =>
                      renderLegFields(leg, outboundLegs.length + index),
                    )}
                  </div>
                )}

                {preview && !entry.appendedFlightNo && (
                  <AppendFlightControl entry={entry} airlinePrefix={airlinePrefix} />
                )}

                <button
                  type="submit"
                  disabled={entry.submitting}
                  className="min-h-[48px] rounded bg-accent px-3 py-2 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                >
                  {entry.pendingSubmit ? "Adding…" : "Add to roster"}
                </button>
              </>
            );
          })()}

        {entry.resolving && (
          <p data-testid="schedule-loading" className="text-sm text-ink-muted">
            checking schedule…
          </p>
        )}

        {/* Manual entry is a miss-only fallback: the schedule provider is the source of truth,
            so the link stays hidden until a lookup actually comes back empty. */}
        {entry.lookupMiss && !entry.autofillLegs && !entry.resolving && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">unknown flight — enter details</p>
            <button
              type="button"
              data-testid="manual-expand"
              onClick={entry.switchToManual}
              className="w-fit text-sm text-ink-muted underline transition-colors duration-[120ms] hover:text-ink"
            >
              enter manually
            </button>
          </div>
        )}

        {entry.error && (
          <p role="alert" className="text-sm text-ink-muted">
            {entry.error}
          </p>
        )}
        </form>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void entry.handleManualSubmit();
      }}
      className="flex flex-col gap-4"
    >
      {entry.legs.map((leg, index) => {
        const originInfo = entry.airportLabel(leg.origin);
        const destInfo = entry.airportLabel(leg.dest);
        return (
          <fieldset key={index} className="flex flex-col gap-2 border-t border-edge pt-3 first:border-t-0 first:pt-0">
            <label htmlFor={`flight-no-${index}`} className="text-sm text-ink-muted">
              Flight no
            </label>
            <input
              id={`flight-no-${index}`}
              value={leg.flightNo}
              onChange={(e) => entry.updateLeg(index, { flightNo: e.target.value.toUpperCase() })}
              className="rounded border border-edge bg-raised px-3 py-2 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />

            <label htmlFor={`origin-${index}`} className="text-sm text-ink-muted">
              Origin
            </label>
            <input
              id={`origin-${index}`}
              value={leg.origin}
              onChange={(e) => entry.updateLeg(index, { origin: e.target.value.toUpperCase() })}
              onBlur={(e) => entry.lookupAirport(e.target.value)}
              className="rounded border border-edge bg-raised px-3 py-2 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />
            {originInfo && <p className="text-sm text-ink-muted">{originInfo}</p>}

            <label htmlFor={`dest-${index}`} className="text-sm text-ink-muted">
              Dest
            </label>
            <input
              id={`dest-${index}`}
              value={leg.dest}
              onChange={(e) => entry.updateLeg(index, { dest: e.target.value.toUpperCase() })}
              onBlur={(e) => entry.lookupAirport(e.target.value)}
              className="rounded border border-edge bg-raised px-3 py-2 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />
            {destInfo && <p className="text-sm text-ink-muted">{destInfo}</p>}

            <label htmlFor={`dep-${index}`} className="text-sm text-ink-muted">
              Departure (local)
            </label>
            <input
              id={`dep-${index}`}
              type="datetime-local"
              value={leg.dep}
              onChange={(e) => entry.updateLeg(index, { dep: e.target.value })}
              className="num rounded border border-edge bg-raised px-3 py-2 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />

            <label htmlFor={`arr-${index}`} className="text-sm text-ink-muted">
              Arrival (local)
            </label>
            <input
              id={`arr-${index}`}
              type="datetime-local"
              value={leg.arr}
              onChange={(e) => entry.updateLeg(index, { arr: e.target.value })}
              className="num rounded border border-edge bg-raised px-3 py-2 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />
          </fieldset>
        );
      })}

      <button
        type="button"
        onClick={entry.addLeg}
        className="min-h-[48px] rounded border border-edge px-3 py-2 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
      >
        Add leg
      </button>

      <button
        type="submit"
        disabled={entry.submitting}
        className="min-h-[48px] rounded bg-accent px-3 py-2 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
      >
        Add to roster
      </button>

      {entry.error && (
        <p role="alert" className="text-sm text-ink-muted">
          {entry.error}
        </p>
      )}
    </form>
  );
}

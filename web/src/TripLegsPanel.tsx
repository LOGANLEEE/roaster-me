import { formatLocal } from "@danyeowa/shared";
import type { TripWithFlights } from "./api";

/**
 * A trip's legs, read-only — times come from the schedule provider, not the crew. Rendered
 * inline by the day card, so viewing a trip never opens a sheet. Delete lives in the card
 * header alongside edit, where both actions sit together out of the reading path.
 */
export default function TripLegsPanel({ trip }: { trip: TripWithFlights }) {
  // A non-operating leg sits on one side of her duty or the other, and they are different facts:
  // the sectors before are how the aircraft reached her, the ones after are where it goes next.
  // Split on her first operating departure — with no operating leg at all (a trip that is
  // entirely someone else's routing, which the form does not allow) everything reads as onward.
  const firstOperatingDep = [...trip.flights].sort((a, b) => a.legSeq - b.legSeq)[0]?.depUtc;
  const continuation = [...(trip.continuation ?? [])].sort((a, b) => a.legSeq - b.legSeq);
  const beforeBoarding = firstOperatingDep
    ? continuation.filter((f) => f.depUtc < firstOperatingDep)
    : [];
  const afterLanding = continuation.filter((f) => !beforeBoarding.includes(f));

  const routingBlock = (legs: typeof continuation, testId: string, heading: string) =>
    legs.length > 0 && (
      <div data-testid={testId} className="flex flex-col gap-2">
        <p className="text-sm text-ink-muted">{heading}</p>
        {legs.map((flight) => (
          <div
            key={flight.id}
            className="flex flex-col gap-1 rounded-lg border border-dashed border-edge p-3 opacity-70"
          >
            <p className="text-ink-muted">
              {flight.origin} → {flight.dest} <span className="text-ink-muted">{flight.flightNo}</span>
            </p>
            <p className="num text-sm text-ink-muted">
              dep {formatLocal(flight.depUtc, flight.depTz)} → arr {formatLocal(flight.arrUtc, flight.arrTz)}
            </p>
          </div>
        ))}
      </div>
    );

  return (
    <div data-testid="trip-legs-panel" className="flex flex-col gap-3">
      {[...trip.flights]
        .sort((a, b) => a.legSeq - b.legSeq)
        .map((flight) => (
          <div key={flight.id} className="flex flex-col gap-1 rounded-lg border border-edge bg-raised p-3">
            <p className="text-ink">
              {flight.origin} → {flight.dest} <span className="text-ink-muted">{flight.flightNo}</span>
            </p>
            <p className="num text-sm text-ink-muted">
              dep {formatLocal(flight.depUtc, flight.depTz)} → arr {formatLocal(flight.arrUtc, flight.arrTz)}
            </p>
            <p className="num text-sm text-report">Report {formatLocal(flight.reportUtc, flight.depTz)}</p>
          </div>
        ))}

      {/* The aircraft's own routing on either side of her duty: sectors she does not work, kept
          so the routing reads true. Muted, no report time — nothing here is her duty, and none of
          it counts towards her landing time. */}
      {routingBlock(beforeBoarding, "trip-prior-routing", "Aircraft arrives before you board")}
      {routingBlock(afterLanding, "trip-continuation", "Aircraft continues without you")}
    </div>
  );
}

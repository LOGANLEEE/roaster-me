import { and, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { formatLocal } from "@danyeowa/shared";
import * as schema from "./db/schema";
import { sendPush } from "./webpush";
import type { Env } from "./index";

// Upper bound on how far ahead a flight's report time can be and still be pulled into
// the candidate set, regardless of any individual user's lead_minutes preference (max
// allowed lead is 360 per NotificationPrefsSchema) plus one cron period of slack so a
// flight landing right at the edge of a 15-minute scan window is never missed.
const MAX_LEAD_MINUTES = 360;
const CRON_SLACK_MINUTES = 15;
const MAX_WINDOW_MS = (MAX_LEAD_MINUTES + CRON_SLACK_MINUTES) * 60 * 1000;

function db(env: Env) {
  return drizzle(env.DB, { schema });
}

/**
 * Race-safe "claim" of a flight for notification: only succeeds (returns true) if this
 * call is the one that flips report_notified_at from NULL to `stampMs`. A second
 * concurrent/overlapping cron invocation racing on the same flight id will see
 * `changes === 0` and skip sending - this is what makes double-run idempotent even
 * without a lock.
 */
async function claimFlightForNotification(
  database: ReturnType<typeof db>,
  flightId: string,
  stampMs: number,
): Promise<boolean> {
  const result = await database
    .update(schema.flights)
    .set({ reportNotifiedAt: stampMs })
    .where(and(eq(schema.flights.id, flightId), isNull(schema.flights.reportNotifiedAt)))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Puts a claimed flight back when nothing was actually delivered.
 *
 * The claim is a concurrency guard, not a receipt. Every send failing (a push service 500, a
 * network error — anything that is not a 404/410 expiry) used to leave the stamp behind, and the
 * candidate query filters on it, so the flight was burned: no retry on the next cron, ever.
 * Measured on production 2026-08-31 — eight flights carried a `report_notified_at` and the
 * database held one push subscription in total, so most of those stamps recorded a delivery to
 * nobody.
 */
async function releaseFlightClaim(
  database: ReturnType<typeof db>,
  flightId: string,
): Promise<void> {
  await database
    .update(schema.flights)
    .set({ reportNotifiedAt: null })
    .where(eq(schema.flights.id, flightId))
    .run();
}

/** The arrival counterpart of `releaseFlightClaim` — puts both columns back as they were. */
async function releaseArrivalStage(
  database: ReturnType<typeof db>,
  flightId: string,
  previousStage: number | null,
  previousNotifiedAt: number | null,
): Promise<void> {
  await database
    .update(schema.flights)
    .set({ arrivalAlertStage: previousStage, arrivalNotifiedAt: previousNotifiedAt })
    .where(eq(schema.flights.id, flightId))
    .run();
}

/**
 * Minutes before arrival at which to ping, largest first. 0 is "it is landing now".
 *
 * Three fixed stages rather than a user-configured list: the useful moments for meeting someone
 * are "set off", "get moving" and "they're down", and a free-form list would be a settings
 * screen nobody wants to fill in.
 */
export const ARRIVAL_STAGES = [60, 30, 0] as const;

/**
 * A landing alert has to fire slightly AFTER the arrival time, so the candidate window reaches
 * back as well as forward. One cron period plus slack, so a flight that lands between two scans
 * still gets its "landed" ping rather than being silently skipped.
 */
const ARRIVAL_LOOKBACK_MS = 20 * 60 * 1000;

/**
 * Claims one stage. The guard is `stage < recorded`, so a re-run at the same stage does nothing
 * while the next stage down still gets through — which is what makes three alerts per flight
 * idempotent without a lock or a row per alert.
 */
async function claimArrivalStage(
  database: ReturnType<typeof db>,
  flightId: string,
  stage: number,
  currentStage: number | null,
  stampMs: number,
): Promise<boolean> {
  const result = await database
    .update(schema.flights)
    .set({ arrivalAlertStage: stage, arrivalNotifiedAt: stampMs })
    .where(
      and(
        eq(schema.flights.id, flightId),
        currentStage === null
          ? isNull(schema.flights.arrivalAlertStage)
          : eq(schema.flights.arrivalAlertStage, currentStage),
      ),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * "Her flight lands in an hour" — the alert for whoever is meeting a flight rather than working
 * it, keyed on arrival instead of report time.
 *
 * Fires three times per flight — 60 min out, 30 min out, and on landing — rather than once at
 * the user's report-time lead, because meeting someone has distinct moments: set off, get
 * moving, they're down. It ignores lead_minutes for that reason and is opt-outable on its own
 * via arrival_enabled.
 *
 * Times come from the flight row's arr_utc, so an alert is only as current as that column. A
 * delay the app never learned about will produce an early "landing now". Keeping that honest
 * needs a live status source the Worker can reach, which is a separate problem — see
 * docs/DECISIONS.md on fr24 being reachable only from inside a browser page.
 */
export async function runArrivalScan(env: Env, nowMs: number): Promise<ReportScanResult> {
  const database = db(env);
  const windowStartIso = new Date(nowMs - ARRIVAL_LOOKBACK_MS).toISOString();
  const windowEndIso = new Date(nowMs + MAX_WINDOW_MS).toISOString();

  const candidates = await database
    .select({
      id: schema.flights.id,
      userId: schema.flights.userId,
      flightNo: schema.flights.flightNo,
      origin: schema.flights.origin,
      dest: schema.flights.dest,
      arrUtc: schema.flights.arrUtc,
      arrivalAlertStage: schema.flights.arrivalAlertStage,
      arrivalNotifiedAt: schema.flights.arrivalNotifiedAt,
    })
    .from(schema.flights)
    .where(
      and(
        gte(schema.flights.arrUtc, windowStartIso),
        lte(schema.flights.arrUtc, windowEndIso),
        // Only sectors the crew member actually works. This query reads `flights` directly, so
        // it never sees the operating/continuation split /api/trips applies — it is the one
        // place that must remember the flag, and forgetting it announces a landing she is not on.
        eq(schema.flights.operating, true),
        // Stage 0 is the last one, so a flight that has had it is finished.
        or(isNull(schema.flights.arrivalAlertStage), gt(schema.flights.arrivalAlertStage, 0)),
      ),
    );

  const result: ReportScanResult = {
    scanned: candidates.length,
    notified: 0,
    skippedOutsideLead: 0,
    expiredSubscriptionsRemoved: 0,
    skippedNoSubscription: 0,
    releasedAfterSendFailure: 0,
  };
  if (candidates.length === 0) return result;

  const userIds = [...new Set(candidates.map((f) => f.userId))];
  const destCodes = [...new Set(candidates.map((f) => f.dest))];

  const [prefsRows, airportRows] = await Promise.all([
    database.select().from(schema.notificationPrefs).where(inArray(schema.notificationPrefs.userId, userIds)),
    database.select().from(schema.airports).where(inArray(schema.airports.iata, destCodes)),
  ]);
  const prefsByUser = new Map(prefsRows.map((p) => [p.userId, p]));
  const airportByIata = new Map(airportRows.map((a) => [a.iata, a]));

  for (const flight of candidates) {
    const prefs = prefsByUser.get(flight.userId) ?? {
      enabled: true,
      leadMinutes: 120,
      arrivalEnabled: true,
    };
    if (!prefs.enabled || !prefs.arrivalEnabled) {
      result.skippedOutsideLead++;
      continue;
    }

    const minutesUntilArrival = (Date.parse(flight.arrUtc) - nowMs) / 60_000;

    // The stage that is due now: the smallest offset already reached, but only if it hasn't
    // been sent. Picking the smallest means a scan that straddles two stages (a 15-minute cron
    // over a 30-minute gap) sends the one that matches reality, not a stale "in 60 minutes".
    const due = ARRIVAL_STAGES.filter(
      (stage) =>
        minutesUntilArrival <= stage &&
        (flight.arrivalAlertStage === null || stage < flight.arrivalAlertStage),
    );
    const stage = due.length ? Math.min(...due) : null;
    if (stage === null) {
      result.skippedOutsideLead++;
      continue;
    }

    const subs = await database
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, flight.userId));
    if (subs.length === 0) {
      result.skippedNoSubscription++;
      continue;
    }

    const claimed = await claimArrivalStage(database, flight.id, stage, flight.arrivalAlertStage, nowMs);
    if (!claimed) continue;

    // Local time AT THE DESTINATION: the person waiting is standing in the arrivals hall.
    const destTz = airportByIata.get(flight.dest)?.tz ?? "UTC";
    const arrivalLocal = formatLocal(flight.arrUtc, destTz);
    const minutesOut = Math.max(0, Math.round(minutesUntilArrival));

    const payload = {
      title:
        stage === 0
          ? `${flight.flightNo} landing now`
          : `${flight.flightNo} lands in ${minutesOut} min`,
      body: `${flight.origin} → ${flight.dest}, arrives ${arrivalLocal}`,
      // Per stage, so the three alerts don't collapse into one another in the notification tray.
      tag: `arrival-${flight.id}-${stage}`,
    };

    let sentAny = false;
    for (const sub of subs) {
      const sendResult = await sendPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        payload,
        env,
      );
      if (sendResult.ok) sentAny = true;
      else if (sendResult.expired) {
        await database.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
        result.expiredSubscriptionsRemoved++;
      }
    }
    if (sentAny) {
      result.notified++;
    } else {
      // Back to the stage this flight was on before the claim, so the next cron re-offers it.
      // `arrivalNotifiedAt` goes back with it rather than being left as a timestamp for a
      // notification nobody got.
      await releaseArrivalStage(database, flight.id, flight.arrivalAlertStage, flight.arrivalNotifiedAt);
      result.releasedAfterSendFailure++;
    }
  }

  return result;
}

export type ReportScanResult = {
  scanned: number;
  notified: number;
  skippedOutsideLead: number;
  expiredSubscriptionsRemoved: number;
  /** Candidates whose owner has no device registered. Left unclaimed, so subscribing later
   * still catches an alert that has not yet passed. */
  skippedNoSubscription: number;
  /** Claimed, then every send failed for a reason that was not an expiry, so the claim was
   * put back and the next cron will try again. */
  releasedAfterSendFailure: number;
};

/**
 * Core report-time notification scan, factored out of the `scheduled` handler so it
 * can be invoked directly in tests (vitest-pool-workers' scheduled-handler test
 * support is awkward to set up reliably; a plain async function is trivial to call
 * with fixture data and a fixed `nowMs`).
 *
 * Candidates: flights with report_utc in [now, now + MAX_LEAD_MINUTES + cron slack)
 * that haven't been notified yet, joined to their owning user's notification prefs.
 * Each candidate is then filtered by that user's OWN lead_minutes (default 120,
 * disabled users skipped entirely) before a stamp-then-send attempt.
 */
export async function runReportScan(env: Env, nowMs: number): Promise<ReportScanResult> {
  const database = db(env);
  const nowIso = new Date(nowMs).toISOString();
  const windowEndIso = new Date(nowMs + MAX_WINDOW_MS).toISOString();

  const candidates = await database
    .select({
      id: schema.flights.id,
      userId: schema.flights.userId,
      flightNo: schema.flights.flightNo,
      origin: schema.flights.origin,
      dest: schema.flights.dest,
      reportUtc: schema.flights.reportUtc,
      reportNotifiedAt: schema.flights.reportNotifiedAt,
    })
    .from(schema.flights)
    .where(
      and(
        gte(schema.flights.reportUtc, nowIso),
        lte(schema.flights.reportUtc, windowEndIso),
        // See the arrival scan above: direct read of `flights`, so the flag is explicit here.
        eq(schema.flights.operating, true),
        isNull(schema.flights.reportNotifiedAt),
      ),
    );

  const result: ReportScanResult = {
    scanned: candidates.length,
    notified: 0,
    skippedOutsideLead: 0,
    expiredSubscriptionsRemoved: 0,
    skippedNoSubscription: 0,
    releasedAfterSendFailure: 0,
  };

  if (candidates.length === 0) return result;

  const userIds = [...new Set(candidates.map((f) => f.userId))];
  const originCodes = [...new Set(candidates.map((f) => f.origin))];

  const [prefsRows, airportRows] = await Promise.all([
    database.select().from(schema.notificationPrefs).where(inArray(schema.notificationPrefs.userId, userIds)),
    database.select().from(schema.airports).where(inArray(schema.airports.iata, originCodes)),
  ]);
  const prefsByUser = new Map(prefsRows.map((p) => [p.userId, p]));
  const airportByIata = new Map(airportRows.map((a) => [a.iata, a]));

  for (const flight of candidates) {
    // Default prefs (enabled, 120min lead) mirror push.ts's DEFAULT_PREFS: a user who
    // never touched settings still gets notified.
    const prefs = prefsByUser.get(flight.userId) ?? { enabled: true, leadMinutes: 120 };
    if (!prefs.enabled) {
      result.skippedOutsideLead++;
      continue;
    }

    const minutesUntilReport = (Date.parse(flight.reportUtc) - nowMs) / 60_000;
    if (minutesUntilReport > prefs.leadMinutes) {
      result.skippedOutsideLead++;
      continue;
    }

    // Subscriptions BEFORE the claim. A user with no device cannot be notified, and claiming
    // first stamped the flight as done and made it invisible to every later scan — so signing
    // in on a phone tomorrow could never recover today's alert.
    const subs = await database
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, flight.userId));
    if (subs.length === 0) {
      result.skippedNoSubscription++;
      continue;
    }

    const claimed = await claimFlightForNotification(database, flight.id, nowMs);
    if (!claimed) continue; // already claimed by another (overlapping) scan run

    const originTz = airportByIata.get(flight.origin)?.tz ?? "UTC";
    const reportLocal = formatLocal(flight.reportUtc, originTz);
    const leaveByLocal = formatLocal(
      new Date(Date.parse(flight.reportUtc) - prefs.leadMinutes * 60_000).toISOString(),
      originTz,
    );

    const payload = {
      title: `Report ${reportLocal} — ${flight.origin} → ${flight.dest}`,
      body: `leave home by ${leaveByLocal}`,
      tag: flight.id,
    };

    let sentAny = false;
    for (const sub of subs) {
      const sendResult = await sendPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        payload,
        env,
      );
      if (sendResult.ok) {
        sentAny = true;
      } else if (sendResult.expired) {
        await database.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
        result.expiredSubscriptionsRemoved++;
      }
    }
    if (sentAny) {
      result.notified++;
    } else {
      await releaseFlightClaim(database, flight.id);
      result.releasedAfterSendFailure++;
    }
  }

  return result;
}

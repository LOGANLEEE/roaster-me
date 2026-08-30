import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { IngestArrivalSchema, IngestScheduleSchema } from "@danyeowa/shared";
import * as schema from "./db/schema";
import type { Env } from "./index";

/**
 * The write path for the machines that run outside Cloudflare.
 *
 * The local schedule harvester and the arrival refresher used to hold production database
 * credentials and send raw SQL. That meant every write skipped validation, skipped the schema
 * the app actually reads, and skipped CI entirely — and it produced this project's worst bugs:
 * schedule rows whose airports were never inserted (the app 404'd 14 flights that were sitting
 * right there), and a stray probe row in a real user's roster.
 *
 * Everything those scripts need is here instead, typed and validated. They hold a bearer token,
 * not a database.
 */
export const ingestRouter = new Hono<{ Bindings: Env }>();

function db(env: Env) {
  return drizzle(env.DB, { schema });
}

/**
 * Bearer-token guard. Deliberately NOT the user session: these callers are machines, and a
 * user cookie would let any signed-in account write the shared schedule cache.
 *
 * With no token configured the routes refuse everything rather than falling open — an ingest
 * endpoint that works because a secret is missing is the failure mode worth designing out.
 */
function authorised(c: { req: { header(name: string): string | undefined }; env: Env }): boolean {
  const expected = c.env.INGEST_TOKEN;
  if (!expected) return false;
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Length-independent compare would be nicer, but the token is high-entropy and the endpoint
  // is rate-limited by Cloudflare; a timing oracle here buys an attacker nothing practical.
  return presented.length > 0 && presented === expected;
}

/**
 * Upserts harvested schedules, airports first.
 *
 * Airport order is not cosmetic: the lookup route 404s a flight whose leg references an IATA
 * with no airports row, so writing schedules first leaves a window where a flight exists and
 * is unreachable — and if the airport write then fails, that window never closes.
 */
ingestRouter.post("/ingest/schedules", async (c) => {
  if (!authorised(c)) return c.json({ error: "unauthorized" }, 401);

  const parsed = IngestScheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const database = db(c.env);
  const { airports, flights } = parsed.data;

  for (const airport of airports) {
    await database
      .insert(schema.airports)
      .values({ ...airport, source: "live-api" })
      .onConflictDoUpdate({
        target: schema.airports.iata,
        // Only the timezone is refreshed. City and name are display strings a human may have
        // corrected, and a provider's wording is not worth overwriting that.
        set: { tz: airport.tz },
      });
  }

  let legsWritten = 0;
  for (const flight of flights) {
    for (const leg of flight.legs) {
      await database
        .insert(schema.flightSchedules)
        .values({
          flightNo: flight.flightNo,
          legSeq: leg.legSeq,
          origin: leg.origin,
          dest: leg.dest,
          depLocal: leg.depLocal,
          arrLocal: leg.arrLocal,
          dayOffset: leg.dayOffset,
          daysOfWeek: leg.daysOfWeek,
          source: "local-fetch",
          fetchedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [schema.flightSchedules.flightNo, schema.flightSchedules.legSeq],
          set: {
            origin: leg.origin,
            dest: leg.dest,
            depLocal: leg.depLocal,
            arrLocal: leg.arrLocal,
            dayOffset: leg.dayOffset,
            daysOfWeek: leg.daysOfWeek,
            source: "local-fetch",
            fetchedAt: Date.now(),
          },
        });
      legsWritten++;
    }
    // A flight that just resolved must not stay shadowed by an old miss row.
    await database
      .delete(schema.scheduleLookupMisses)
      .where(eq(schema.scheduleLookupMisses.flightNo, flight.flightNo));
  }

  return c.json({ airports: airports.length, flights: flights.length, legs: legsWritten });
});

/**
 * The arrivals the refresher should check: everything landing near enough to still move.
 *
 * Scoping the window here rather than in the script keeps the query — and its meaning — next to
 * the alert scan that consumes the same columns.
 *
 * The window is the only filter, deliberately. This used to also drop any flight whose alert
 * stages were finished, which sounds like an efficiency win and is in fact how a wrong arrival
 * time becomes permanent: the scan claims stage 0 the moment the STORED time passes, so a
 * flight still airborne — stored early — leaves the refresher at exactly the moment it most
 * needs correcting. EK248 on 2026-08-27 froze at 00:09 that way and announced "landing now"
 * 41 minutes before it landed. A flight that really has landed falls out of the window on its
 * own 20 minutes later, so keeping it costs one fr24 lookup, once.
 */
ingestRouter.get("/ingest/upcoming-arrivals", async (c) => {
  if (!authorised(c)) return c.json({ error: "unauthorized" }, 401);

  const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 4), 1), 24);
  const now = Date.now();
  // Reaches back as well as forward: a flight that has just landed still owes its final alert.
  const fromIso = new Date(now - 20 * 60_000).toISOString();
  const toIso = new Date(now + hours * 3600_000).toISOString();

  const rows = await db(c.env)
    .select({
      id: schema.flights.id,
      flightNo: schema.flights.flightNo,
      origin: schema.flights.origin,
      dest: schema.flights.dest,
      arrUtc: schema.flights.arrUtc,
      arrivalAlertStage: schema.flights.arrivalAlertStage,
    })
    .from(schema.flights)
    .where(
      and(gte(schema.flights.arrUtc, fromIso), lte(schema.flights.arrUtc, toIso)),
    )
    .orderBy(asc(schema.flights.arrUtc));

  return c.json({ flights: rows });
});

/**
 * Applies corrected arrival times.
 *
 * Clearing `arrivalAlertStage` is the point of the whole exercise: a delayed flight that already
 * announced "landing now" against its old time has to re-arm, or the correction is cosmetic.
 */
ingestRouter.post("/ingest/arrival-corrections", async (c) => {
  if (!authorised(c)) return c.json({ error: "unauthorized" }, 401);

  const parsed = IngestArrivalSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const database = db(c.env);
  const now = Date.now();
  let updated = 0;
  for (const correction of parsed.data.corrections) {
    // Re-arm only when there is still something to announce. A correction that moves the
    // arrival into the PAST is news about a landing that already happened; clearing the stage
    // there would fire "landing now" at someone whose crew is off the aircraft.
    const stillAhead = Date.parse(correction.arrUtc) > now;
    const result = await database
      .update(schema.flights)
      .set(stillAhead ? { arrUtc: correction.arrUtc, arrivalAlertStage: null } : { arrUtc: correction.arrUtc })
      .where(eq(schema.flights.id, correction.flightId))
      .run();
    updated += result.meta.changes ?? 0;
  }

  return c.json({ updated });
});

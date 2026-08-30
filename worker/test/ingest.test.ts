import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import * as schema from "../src/db/schema";

/**
 * The write path the local scripts use instead of holding production database credentials.
 *
 * What these tests are really protecting is the reason it exists: a script with raw SQL access
 * writes whatever it likes, unvalidated and untested, and this project has the scars — schedule
 * rows whose airports were never inserted, a `source` value the schema did not even define, and
 * a probe row left in a real user's roster.
 */
const TOKEN = "test-ingest-token";

function testEnv(overrides: Record<string, unknown> = {}) {
  return { ...env, INGEST_TOKEN: TOKEN, ...overrides } as typeof env & { INGEST_TOKEN?: string };
}

function db() {
  return drizzle(env.DB, { schema });
}

function post(path: string, body: unknown, token: string | null = TOKEN, envOverride = testEnv()) {
  return app.fetch(
    new Request(`https://x.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    envOverride,
  );
}

const VALID = {
  airports: [
    { iata: "DXB", city: "Dubai", name: "Dubai International", tz: "Asia/Dubai" },
    { iata: "GIG", city: "Rio de Janeiro", name: "Galeao", tz: "America/Sao_Paulo" },
  ],
  flights: [
    {
      flightNo: "EK247",
      legs: [
        {
          legSeq: 0,
          origin: "DXB",
          dest: "GIG",
          depLocal: "08:05",
          arrLocal: "15:50",
          dayOffset: 0,
          daysOfWeek: "1234567",
        },
      ],
    },
  ],
};

describe("POST /api/ingest/schedules", () => {
  beforeEach(async () => {
    await db().delete(schema.flightSchedules).where(eq(schema.flightSchedules.flightNo, "EK247"));
  });

  it("rejects a request with no token", async () => {
    expect((await post("/api/ingest/schedules", VALID, null)).status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    expect((await post("/api/ingest/schedules", VALID, "nope")).status).toBe(401);
  });

  it("refuses everything when no token is configured, rather than falling open", async () => {
    // An ingest endpoint that works because a secret is missing is the failure this guards.
    const res = await post("/api/ingest/schedules", VALID, TOKEN, testEnv({ INGEST_TOKEN: undefined }));
    expect(res.status).toBe(401);
  });

  it("writes airports and legs together", async () => {
    const res = await post("/api/ingest/schedules", VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ airports: 2, flights: 1, legs: 1 });

    const legs = await db()
      .select()
      .from(schema.flightSchedules)
      .where(eq(schema.flightSchedules.flightNo, "EK247"));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ origin: "DXB", dest: "GIG", source: "local-fetch" });

    const [gig] = await db().select().from(schema.airports).where(eq(schema.airports.iata, "GIG"));
    expect(gig).toMatchObject({ tz: "America/Sao_Paulo" });
  });

  it("is idempotent — a re-post updates in place instead of duplicating", async () => {
    await post("/api/ingest/schedules", VALID);
    await post("/api/ingest/schedules", VALID);
    const legs = await db()
      .select()
      .from(schema.flightSchedules)
      .where(eq(schema.flightSchedules.flightNo, "EK247"));
    expect(legs).toHaveLength(1);
  });

  it("clears a stale miss row for a flight that just resolved", async () => {
    await db()
      .insert(schema.scheduleLookupMisses)
      .values({ flightNo: "EK247", missedAt: Date.now() })
      .onConflictDoNothing();
    await post("/api/ingest/schedules", VALID);
    const misses = await db()
      .select()
      .from(schema.scheduleLookupMisses)
      .where(eq(schema.scheduleLookupMisses.flightNo, "EK247"));
    expect(misses).toHaveLength(0);
  });

  it("rejects a fabricated timezone", async () => {
    // The lookup route will not serve a leg whose airport has no usable zone, so an invented
    // one is worse than a missing airport: it computes wrong report times silently.
    const res = await post("/api/ingest/schedules", {
      ...VALID,
      airports: [{ iata: "ZZZ", city: "Nowhere", name: "Nowhere Intl", tz: "Not A Zone" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed flight number", async () => {
    const res = await post("/api/ingest/schedules", {
      airports: [],
      flights: [{ ...VALID.flights[0], flightNo: "NOT-A-FLIGHT" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a leg with a broken clock time", async () => {
    const res = await post("/api/ingest/schedules", {
      airports: [],
      flights: [{ flightNo: "EK247", legs: [{ ...VALID.flights[0]!.legs[0]!, depLocal: "8am" }] }],
    });
    expect(res.status).toBe(400);
  });
});

describe("ingest arrivals", () => {
  async function makeFlight(arrUtc: string, stage: number | null = 30): Promise<string> {
    const userId = crypto.randomUUID();
    await db().insert(schema.user).values({ id: userId, name: "ingest", email: `${userId}@local.test` });
    const tripId = crypto.randomUUID();
    await db().insert(schema.trips).values({ id: tripId, userId, label: "ingest" });
    const id = crypto.randomUUID();
    await db().insert(schema.flights).values({
      id,
      tripId,
      userId,
      flightNo: "EK373",
      origin: "BKK",
      dest: "DXB",
      depUtc: "2026-08-31T14:35:00.000Z",
      arrUtc,
      reportUtc: "2026-08-31T12:00:00.000Z",
      depTz: "Asia/Bangkok",
      arrTz: "Asia/Dubai",
      arrivalAlertStage: stage,
    });
    return id;
  }

  it("lists every arrival inside the window, finished alert stages included", async () => {
    // The third one is the case that matters. Its alert stages are finished while its arrival
    // is still an hour out, which is precisely what a stored-too-early time looks like after
    // the scan has declared it landed. Excluding it — as this endpoint used to — is what froze
    // EK248 at 00:09 and pushed "landing now" 41 minutes early.
    const soon = await makeFlight(new Date(Date.now() + 60 * 60_000).toISOString(), null);
    const partway = await makeFlight(new Date(Date.now() + 60 * 60_000).toISOString(), 30);
    const finishedButNotDown = await makeFlight(new Date(Date.now() + 60 * 60_000).toISOString(), 0);
    const longGone = await makeFlight(new Date(Date.now() - 3 * 3600_000).toISOString(), 0);
    const res = await app.fetch(
      new Request("https://x.test/api/ingest/upcoming-arrivals?hours=4", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      testEnv(),
    );
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { flights: { id: string }[] }).flights.map((f) => f.id);
    expect(ids).toContain(soon);
    expect(ids).toContain(partway);
    expect(ids).toContain(finishedButNotDown);
    // The time window is what retires a flight now, and it still does.
    expect(ids).not.toContain(longGone);
  });

  it("applies a correction and re-arms the alert stages", async () => {
    // Without the stage reset a delayed flight keeps whatever it announced against the old
    // time and goes quiet, which makes the correction cosmetic.
    const id = await makeFlight(new Date(Date.now() + 60 * 60_000).toISOString(), 30);
    const corrected = new Date(Date.now() + 150 * 60_000).toISOString();
    const res = await post("/api/ingest/arrival-corrections", {
      corrections: [{ flightId: id, arrUtc: corrected }],
    });
    expect(res.status).toBe(200);

    const [row] = await db().select().from(schema.flights).where(eq(schema.flights.id, id));
    expect(row?.arrUtc).toBe(corrected);
    expect(row?.arrivalAlertStage).toBeNull();
  });

  it("does not re-arm when the corrected arrival is already in the past", async () => {
    // fr24 reporting an actual landing that has already happened is not a reason to announce
    // it. Re-arming here would fire "landing now" at a family whose crew is already in the car.
    const id = await makeFlight(new Date(Date.now() + 60 * 60_000).toISOString(), 0);
    const corrected = new Date(Date.now() - 20 * 60_000).toISOString();
    const res = await post("/api/ingest/arrival-corrections", {
      corrections: [{ flightId: id, arrUtc: corrected }],
    });
    expect(res.status).toBe(200);

    const [row] = await db().select().from(schema.flights).where(eq(schema.flights.id, id));
    expect(row?.arrUtc).toBe(corrected);
    expect(row?.arrivalAlertStage).toBe(0);
  });

  it("rejects a correction with a non-ISO arrival time", async () => {
    const res = await post("/api/ingest/arrival-corrections", {
      corrections: [{ flightId: "whatever", arrUtc: "tomorrow-ish" }],
    });
    expect(res.status).toBe(400);
  });

  it("needs the token for arrivals too", async () => {
    const res = await app.fetch(
      new Request("https://x.test/api/ingest/upcoming-arrivals"),
      testEnv(),
    );
    expect(res.status).toBe(401);
  });
});

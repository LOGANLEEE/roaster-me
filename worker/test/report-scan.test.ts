import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { seedAirports } from "../src/db/seed-airports";
import { runArrivalScan, runReportScan } from "../src/report-scan";
import { __testing } from "../src/webpush";

const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");

function db() {
  return drizzle(env.DB, { schema });
}

/**
 * Inserts a `user` row directly (rather than via the OTP sign-in flow used elsewhere
 * in this suite) purely to satisfy flights/trips/push_subscriptions FK constraints.
 * report-scan tests never authenticate as this user over HTTP, so going through
 * better-auth's OTP flow would only cost a request against its per-IP rate limit
 * (max 3 sends/60s - easily exhausted by this file's ~6 fixture users) for no benefit.
 */
async function makeUser(email: string): Promise<string> {
  const id = crypto.randomUUID();
  await db().insert(schema.user).values({ id, name: email, email });
  return id;
}

async function insertFlight(opts: {
  userId: string;
  reportUtc: string;
  reportNotifiedAt?: number | null;
  origin?: string;
  dest?: string;
  arrUtc?: string;
  arrivalAlertStage?: number | null;
  operating?: boolean;
}): Promise<string> {
  const database = db();
  const tripId = crypto.randomUUID();
  await database.insert(schema.trips).values({ id: tripId, userId: opts.userId, label: "test trip" });
  const flightId = crypto.randomUUID();
  await database.insert(schema.flights).values({
    id: flightId,
    tripId,
    userId: opts.userId,
    flightNo: "EK001",
    origin: opts.origin ?? "DXB",
    dest: opts.dest ?? "SYD",
    depUtc: "2026-09-01T04:00:00.000Z",
    arrUtc: opts.arrUtc ?? "2026-09-01T18:00:00.000Z",
    reportUtc: opts.reportUtc,
    depTz: "Asia/Dubai",
    arrTz: "Australia/Sydney",
    reportNotifiedAt: opts.reportNotifiedAt ?? null,
    arrivalAlertStage: opts.arrivalAlertStage ?? null,
    operating: opts.operating ?? true,
  });
  return flightId;
}

// Real ECDSA P-256 keypair generated fresh for this test file, so sendPush's VAPID
// signing has valid crypto material to work against - never reuse dummy strings for
// actual SubtleCrypto operations.
async function testVapidEnv() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return {
    ...env,
    VAPID_PRIVATE_KEY: __testing.base64urlEncode(pkcs8),
    VAPID_PUBLIC_KEY: __testing.base64urlEncode(raw),
  };
}

/**
 * Inserts a subscription with a REAL P-256 keypair + auth secret (encryptPayload does
 * genuine ECDH/HKDF/AES-GCM against these, so placeholder strings won't round-trip)
 * and returns the receiver's own key material so a test can decrypt the resulting
 * push body exactly as a browser's Push API would, to verify the actual payload sent
 * rather than just its inputs.
 */
async function addSubscription(userId: string, endpoint: string) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  await db().insert(schema.pushSubscriptions).values({
    userId,
    endpoint,
    p256dh: __testing.base64urlEncode(publicKeyRaw),
    auth: __testing.base64urlEncode(authSecret),
  });

  return {
    privateKeyPkcs8Base64: __testing.base64urlEncode(privateKeyPkcs8),
    publicKeyRaw,
    authSecret,
  };
}

/**
 * Decrypts an aes128gcm push body (RFC 8291) as the receiving browser would, using the
 * receiver's own ECDH key material. Used to verify sendPush's actual output payload
 * end-to-end rather than only its inputs.
 */
async function decryptPushBody(
  body: Uint8Array,
  receiver: { privateKeyPkcs8Base64: string; publicKeyRaw: Uint8Array; authSecret: Uint8Array },
): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  if (recordSize !== 4096) throw new Error(`unexpected aes128gcm record size: ${recordSize}`);
  const keyIdLength = body[20]!;
  const asPublicKeyBytes = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);

  const receiverPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(__testing.base64urlDecode(receiver.privateKeyPkcs8Base64)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asPublicKey = await crypto.subtle.importKey(
    "raw",
    asPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asPublicKey }, receiverPrivateKey, 256),
  );

  const { cek, nonce } = await __testing.deriveContentEncryptionParams(
    ecdhSecret,
    receiver.authSecret,
    receiver.publicKeyRaw,
    asPublicKeyBytes,
    salt,
  );

  const cekKey = await crypto.subtle.importKey("raw", new Uint8Array(cek), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const paddedPlaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) }, cekKey, new Uint8Array(ciphertext)),
  );
  // Strip the trailing 0x02 padding delimiter (single-record message, RFC 8291 §4).
  return new TextDecoder().decode(paddedPlaintext.slice(0, paddedPlaintext.length - 1));
}

describe("runReportScan", () => {
  beforeEach(async () => {
    await seedAirports(db());
  });

  it("does nothing when there are no candidate flights", async () => {
    const result = await runReportScan(env, NOW_MS);
    expect(result).toEqual({
      scanned: 0,
      notified: 0,
      skippedOutsideLead: 0,
      expiredSubscriptionsRemoved: 0,
      skippedNoSubscription: 0,
      releasedAfterSendFailure: 0,
    });
  });

  // A multi-sector flight number is one aircraft routing, not one crew duty: EK205 is
  // DXB->MXP->JFK and the crew can change at Milan. The sector she does not work is stored so
  // the routing stays true — but report-scan queries `flights` DIRECTLY by reportUtc/arrUtc,
  // with no trip context at all, so it never sees the API's operating/continuation split. It is
  // the one place the safe-by-default shape does not reach, and the failure is loud: a push
  // announcing a report time she does not have, or a landing she is not on.
  it("does NOT send a report push for a sector the crew member does not operate", async () => {
    const userId = await makeUser("report-scan-not-operating@example.com");
    await addSubscription(userId, "https://push.example.com/not-operating");
    await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 60 * 60 * 1000).toISOString(), // squarely inside the lead window
      operating: false,
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReportScan(testEnv, NOW_MS);

    expect(result.notified).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("does NOT send an arrival push for a sector the crew member does not operate", async () => {
    const userId = await makeUser("arrival-scan-not-operating@example.com");
    await addSubscription(userId, "https://push.example.com/arrival-not-operating");
    await insertFlight({
      userId,
      // Report far outside the window so only the arrival scan can possibly fire.
      reportUtc: new Date(NOW_MS + 30 * 24 * 60 * 60 * 1000).toISOString(),
      arrUtc: new Date(NOW_MS + 30 * 60 * 1000).toISOString(), // 30 min out — a live arrival stage
      operating: false,
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runArrivalScan(testEnv, NOW_MS);

    expect(result.notified).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("sends a push and stamps report_notified_at for a due flight within the user's lead window", async () => {
    const userId = await makeUser("report-scan-due@example.com");
    await addSubscription(userId, "https://push.example.com/due-flight");
    const flightId = await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 60 * 60 * 1000).toISOString(), // 1h out, default lead is 120min
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReportScan(testEnv, NOW_MS);

    expect(result.notified).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [flightRow] = await db().select().from(schema.flights).where(eq(schema.flights.id, flightId));
    expect(flightRow?.reportNotifiedAt).toBe(NOW_MS);

    vi.unstubAllGlobals();
  });

  it("leaves a due flight unclaimed when its owner has no device, so tomorrow's scan can still send it", async () => {
    // Production, 2026-08-31: eight flights carried a report_notified_at and the whole database
    // held ONE push subscription. The stamp went on before the subscription lookup, so a crew
    // member with no device had every alert recorded as delivered — and registering a phone
    // afterwards could never recover one, because the stamp hides the flight from the query.
    const userId = await makeUser("report-scan-no-device@example.com");
    const flightId = await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReportScan(testEnv, NOW_MS);

    expect(result.skippedNoSubscription).toBe(1);
    expect(result.notified).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const [flightRow] = await db().select().from(schema.flights).where(eq(schema.flights.id, flightId));
    expect(flightRow?.reportNotifiedAt).toBeNull();

    // The flight is still a candidate, so a device registered later still gets the alert.
    await addSubscription(userId, "https://push.example.com/registered-later");
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const second = await runReportScan(testEnv, NOW_MS + 1000);
    expect(second.notified).toBe(1);

    vi.unstubAllGlobals();
  });

  it("carries the push service's own error text out of a failed send", async () => {
    // /api/push/test answered `failedWithStatus: [400]` from Apple on 2026-08-31 and there was
    // nothing to do with it — 400 covers a malformed JWT, a bad `k=`, and a body the service
    // will not accept. The status was all the code kept; the reason was thrown away.
    const userId = await makeUser("report-scan-detail@example.com");
    await addSubscription(userId, "https://web.push.example.com/rejects-us");
    await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.join(" "));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("BadJwtToken", { status: 400 })),
    );

    await runReportScan(testEnv, NOW_MS);

    const line = warnings.find((w) => w.startsWith("[push] send failed"));
    expect(line).toContain("status=400");
    expect(line).toContain("BadJwtToken");
    // Host only. The endpoint's path segment is the subscription's bearer credential and must
    // never reach a log anyone with log access can read.
    expect(line).toContain("host=web.push.example.com");
    expect(line).not.toContain("rejects-us");

    // Let it through once. This file shares one database, and the release above leaves the
    // flight a live candidate — every later test's fetch-call count would pick it up.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 201 })));
    await runReportScan(testEnv, NOW_MS + 1000);

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("puts the claim back when every send fails for a reason that is not an expiry", async () => {
    // 404/410 means the subscription is dead and gets deleted. A 500 means the push service had
    // a bad minute — and that used to burn the flight exactly as hard as a successful send.
    const userId = await makeUser("report-scan-send-fails@example.com");
    await addSubscription(userId, "https://push.example.com/server-error");
    const flightId = await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReportScan(testEnv, NOW_MS);

    expect(result.notified).toBe(0);
    expect(result.releasedAfterSendFailure).toBe(1);
    expect(result.expiredSubscriptionsRemoved).toBe(0);

    const [flightRow] = await db().select().from(schema.flights).where(eq(schema.flights.id, flightId));
    expect(flightRow?.reportNotifiedAt).toBeNull();

    // Next cron, push service healthy again: the alert actually goes out.
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const retry = await runReportScan(testEnv, NOW_MS + 1000);
    expect(retry.notified).toBe(1);

    vi.unstubAllGlobals();
  });

  it("does not send a second push on a double run (idempotent stamp)", async () => {
    const userId = await makeUser("report-scan-double@example.com");
    await addSubscription(userId, "https://push.example.com/double-run");
    await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await runReportScan(testEnv, NOW_MS);
    const second = await runReportScan(testEnv, NOW_MS + 1000);

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(second.scanned).toBe(0); // already-notified flight no longer matches the candidate query
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("skips a flight when the user's prefs are disabled", async () => {
    const userId = await makeUser("report-scan-disabled@example.com");
    await db().insert(schema.notificationPrefs).values({ userId, enabled: false, leadMinutes: 120 });
    await addSubscription(userId, "https://push.example.com/disabled-user");
    const flightId = await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runReportScan(testEnv, NOW_MS);

    // Assert on this test's own flight/endpoint rather than the scan-wide counters,
    // which accumulate leftover rows from earlier `it`s sharing the same D1 instance.
    const [flightRow] = await db().select().from(schema.flights).where(eq(schema.flights.id, flightId));
    expect(flightRow?.reportNotifiedAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("https://push.example.com/disabled-user", expect.anything());

    vi.unstubAllGlobals();
  });

  it("skips a flight whose report time is further out than the user's configured lead", async () => {
    const userId = await makeUser("report-scan-outside-lead@example.com");
    await db().insert(schema.notificationPrefs).values({ userId, enabled: true, leadMinutes: 30 });
    await addSubscription(userId, "https://push.example.com/outside-lead");
    const flightId = await insertFlight({
      userId,
      // 90 minutes out, but this user's lead is only 30 minutes - not due yet.
      reportUtc: new Date(NOW_MS + 90 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runReportScan(testEnv, NOW_MS);

    const [flightRow] = await db().select().from(schema.flights).where(eq(schema.flights.id, flightId));
    expect(flightRow?.reportNotifiedAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("https://push.example.com/outside-lead", expect.anything());

    vi.unstubAllGlobals();
  });

  it("deletes a subscription that returns 410 Gone and still counts the flight as notified if another sub succeeds", async () => {
    const userId = await makeUser("report-scan-410@example.com");
    await addSubscription(userId, "https://push.example.com/dead-sub");
    await addSubscription(userId, "https://push.example.com/live-sub");
    await insertFlight({
      userId,
      reportUtc: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
    });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "https://push.example.com/dead-sub") {
        return Promise.resolve(new Response(null, { status: 410 }));
      }
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReportScan(testEnv, NOW_MS);

    expect(result.notified).toBe(1);
    expect(result.expiredSubscriptionsRemoved).toBe(1);

    const remaining = await db()
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.endpoint).toBe("https://push.example.com/live-sub");

    vi.unstubAllGlobals();
  });

  it("builds the payload title/body/tag per the spec format, decrypted end-to-end as a browser would", async () => {
    const userId = await makeUser("report-scan-payload@example.com");
    const receiver = await addSubscription(userId, "https://push.example.com/payload-check");
    const reportUtc = new Date(NOW_MS + 30 * 60 * 1000).toISOString();
    const flightId = await insertFlight({ userId, reportUtc, origin: "DXB", dest: "SYD" });

    const testEnv = await testVapidEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await runReportScan(testEnv, NOW_MS);

    const [, init] = fetchMock.mock.calls[0]!;
    const plaintext = await decryptPushBody(init.body as Uint8Array, receiver);
    const payload = JSON.parse(plaintext);

    const { formatLocal } = await import("@danyeowa/shared");
    const expectedReportLocal = formatLocal(reportUtc, "Asia/Dubai");
    const expectedLeaveBy = formatLocal(
      new Date(Date.parse(reportUtc) - 120 * 60_000).toISOString(), // default lead: 120min
      "Asia/Dubai",
    );

    expect(payload.title).toBe(`Report ${expectedReportLocal} — DXB → SYD`);
    expect(payload.body).toBe(`leave home by ${expectedLeaveBy}`);
    expect(payload.tag).toBe(flightId);

    vi.unstubAllGlobals();
  });
});

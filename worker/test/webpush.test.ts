import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, sendPush } from "../src/webpush";
import type { Env } from "../src/index";

// RFC 8291 Appendix A test vectors, verbatim (whitespace stripped from the RFC's
// wrapped presentation). These are the ONLY gold-standard proof that this hand-rolled
// aes128gcm + VAPID implementation is byte-correct - see webpush.ts's header comment
// for why a library wasn't used instead.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

function b64urlToHex(value: string): string {
  return Buffer.from(__testing.base64urlDecode(value)).toString("hex");
}

describe("RFC 8291 Appendix A vector verification", () => {
  it("derives the exact ECDH shared secret", async () => {
    const asPublicBytes = __testing.base64urlDecode(RFC.asPublic);
    const uaPublicBytes = __testing.base64urlDecode(RFC.uaPublic);
    const secret = await __testing.ecdhSharedSecret(RFC.asPrivate, asPublicBytes, uaPublicBytes);
    expect(Buffer.from(secret).toString("hex")).toBe(b64urlToHex(RFC.ecdhSecret));
  });

  it("derives the exact IKM, CEK, and nonce from the shared secret + auth secret + salt", async () => {
    const asPublicBytes = __testing.base64urlDecode(RFC.asPublic);
    const uaPublicBytes = __testing.base64urlDecode(RFC.uaPublic);
    const ecdhSecret = __testing.base64urlDecode(RFC.ecdhSecret);
    const authSecret = __testing.base64urlDecode(RFC.authSecret);
    const salt = __testing.base64urlDecode(RFC.salt);

    const { ikm, cek, nonce } = await __testing.deriveContentEncryptionParams(
      ecdhSecret,
      authSecret,
      uaPublicBytes,
      asPublicBytes,
      salt,
    );

    expect(Buffer.from(ikm).toString("hex")).toBe(b64urlToHex(RFC.ikm));
    expect(Buffer.from(cek).toString("hex")).toBe(b64urlToHex(RFC.cek));
    expect(Buffer.from(nonce).toString("hex")).toBe(b64urlToHex(RFC.nonce));
  });

  it("produces the exact aes128gcm header (salt || rs=4096 || keyid-len || keyid)", () => {
    const salt = __testing.base64urlDecode(RFC.salt);
    const asPublicBytes = __testing.base64urlDecode(RFC.asPublic);
    const header = __testing.aes128gcmHeader(salt, asPublicBytes);
    expect(Buffer.from(header).toString("hex")).toBe(b64urlToHex(RFC.header));
  });

  it("produces the exact AES-GCM ciphertext for the RFC's plaintext", async () => {
    const cek = __testing.base64urlDecode(RFC.cek);
    const nonce = __testing.base64urlDecode(RFC.nonce);
    const plaintext = __testing.base64urlDecode(RFC.plaintext);
    const ciphertext = await __testing.aesGcmEncrypt(cek, nonce, plaintext);
    expect(Buffer.from(ciphertext).toString("hex")).toBe(b64urlToHex(RFC.ciphertext));
  });

  it("end-to-end: header + ciphertext concatenation matches the RFC's full example body", async () => {
    const asPublicBytes = __testing.base64urlDecode(RFC.asPublic);
    const uaPublicBytes = __testing.base64urlDecode(RFC.uaPublic);
    const authSecret = __testing.base64urlDecode(RFC.authSecret);
    const salt = __testing.base64urlDecode(RFC.salt);
    const plaintext = __testing.base64urlDecode(RFC.plaintext);

    const ecdhSecret = await __testing.ecdhSharedSecret(RFC.asPrivate, asPublicBytes, uaPublicBytes);
    const { cek, nonce } = await __testing.deriveContentEncryptionParams(
      ecdhSecret,
      authSecret,
      uaPublicBytes,
      asPublicBytes,
      salt,
    );
    const ciphertext = await __testing.aesGcmEncrypt(cek, nonce, plaintext);
    const header = __testing.aes128gcmHeader(salt, asPublicBytes);
    const body = Buffer.concat([Buffer.from(header), Buffer.from(ciphertext)]);

    // Section 5's full base64url body (whitespace-wrapped in the RFC; joined here).
    const expected =
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    expect(body.toString("hex")).toBe(b64urlToHex(expected));
  });
});

describe("sendPush", () => {
  const env: Env = {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
  };

  let testKeypairPkcs8: string;
  let testKeypairPublic: string;

  beforeEach(async () => {
    // Real ECDSA P-256 keypair generated fresh via WebCrypto for this test run - never
    // reuse the dummy vitest binding strings for actual crypto, per the plan brief.
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    testKeypairPkcs8 = __testing.base64urlEncode(pkcs8);
    testKeypairPublic = __testing.base64urlEncode(raw);
    env.VAPID_PRIVATE_KEY = testKeypairPkcs8;
    env.VAPID_PUBLIC_KEY = testKeypairPublic;
  });

  function fakeSubscription() {
    return {
      endpoint: "https://push.example.com/subscription/abc123",
      p256dh: RFC.uaPublic,
      auth: RFC.authSecret,
    };
  }

  it("sends a POST with a vapid t=..,k=.. Authorization header and aes128gcm content-encoding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendPush(fakeSubscription(), { title: "Report 08:45" }, env);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://push.example.com/subscription/abc123");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(headers.Authorization).toContain(`k=${testKeypairPublic}`);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("300");

    // The body must not contain the plaintext payload - it's AEAD-encrypted, not JSON.
    const bodyBytes: Uint8Array = init.body;
    const bodyText = Buffer.from(bodyBytes).toString("latin1");
    expect(bodyText).not.toContain("Report 08:45");
    // aes128gcm header is 16 (salt) + 4 (rs) + 1 (keyid len) + 65 (keyid) = 86 bytes,
    // plus ciphertext + 16-byte GCM tag.
    expect(bodyBytes.length).toBeGreaterThan(86 + 16);

    vi.unstubAllGlobals();
  });

  it("signs a VAPID JWT whose payload has aud = endpoint origin, sub = mailto:, and exp within 24h", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPush(fakeSubscription(), { title: "x" }, env);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const jwt = /t=([\w-]+\.[\w-]+\.[\w-]+),/.exec(headers.Authorization ?? "")![1]!;
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(__testing.base64urlDecode(payloadB64!)).toString("utf8"));

    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:korlogan94@gmail.com");
    const nowSec = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeGreaterThan(nowSec);
    expect(payload.exp).toBeLessThanOrEqual(nowSec + 24 * 60 * 60);

    vi.unstubAllGlobals();
  });

  it("returns expired:true on a 410 Gone response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 410 })));
    const result = await sendPush(fakeSubscription(), { title: "x" }, env);
    expect(result).toEqual({ ok: false, status: 410, expired: true, detail: "" });
    vi.unstubAllGlobals();
  });

  it("carries the push service's error text back to the caller", async () => {
    // A status code does not name a cause: Apple answers 400 for a malformed VAPID JWT, a bad
    // `k=`, and a body it will not accept. Production returned exactly that on 2026-08-31 with
    // the reason discarded, so there was nothing to act on.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("BadJwtToken", { status: 400 })),
    );
    const result = await sendPush(fakeSubscription(), { title: "x" }, env);
    expect(result).toEqual({ ok: false, status: 400, expired: false, detail: "BadJwtToken" });
    vi.unstubAllGlobals();
  });

  it("treats a VAPID key mismatch as a dead subscription even though it is a 400", async () => {
    // Production's only subscription, registered 2026-08-10, answered exactly this on
    // 2026-08-31. A subscription is bound to the VAPID key that created it; replace the key
    // pair and it is refused forever — but with a 400, so the 404/410 expiry path never saw it
    // and the row sat there being retried against a service that would never accept it.
    const body = JSON.stringify({ reason: "VapidPkHashMismatch" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 400 })));
    const result = await sendPush(fakeSubscription(), { title: "x" }, env);
    expect(result).toEqual({ ok: false, status: 400, expired: true, detail: body });
    vi.unstubAllGlobals();
  });

  it("returns expired:true on a 404 Not Found response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const result = await sendPush(fakeSubscription(), { title: "x" }, env);
    expect(result).toEqual({ ok: false, status: 404, expired: true, detail: "" });
    vi.unstubAllGlobals();
  });

  it("returns expired:false on a 500 response (transient - do not delete the subscription)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const result = await sendPush(fakeSubscription(), { title: "x" }, env);
    expect(result).toEqual({ ok: false, status: 500, expired: false, detail: "" });
    vi.unstubAllGlobals();
  });

  it("throws if VAPID keys are not configured", async () => {
    const badEnv = { ...env, VAPID_PRIVATE_KEY: undefined };
    await expect(sendPush(fakeSubscription(), { title: "x" }, badEnv)).rejects.toThrow(/VAPID/);
  });

  it("rejects a payload whose pre-encryption JSON exceeds 3800 bytes, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const oversized = { title: "x", body: "a".repeat(3900) };
    await expect(sendPush(fakeSubscription(), oversized, env)).rejects.toThrow(/too large/i);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("uses env.VAPID_CONTACT as the JWT sub when set, falling back to the literal address otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 201 })));

    await sendPush(fakeSubscription(), { title: "x" }, { ...env, VAPID_CONTACT: "mailto:crew@example.com" });
    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    const jwt = /t=([\w-]+\.[\w-]+\.[\w-]+),/.exec(headers.Authorization ?? "")![1]!;
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(__testing.base64urlDecode(payloadB64!)).toString("utf8"));
    expect(payload.sub).toBe("mailto:crew@example.com");

    vi.unstubAllGlobals();
  });
});

// Hand-rolled Web Push sender for Cloudflare Workers: VAPID (RFC 8292) request
// authentication plus "aes128gcm" content encryption (RFC 8291 / RFC 8188), built only
// on the platform SubtleCrypto - no Node crypto, no third-party library.
//
// Why hand-rolled: the two Workers-oriented npm packages that advertise Web Push
// support (`@block65/webcrypto-web-push`, `webpush-webcrypto`) both implement the
// obsoleted `aesgcm` draft content-coding (separate `Encryption`/`Crypto-Key` headers)
// rather than RFC 8291's `aes128gcm` single-body format, and the former also emits the
// legacy `Authorization: WebPush <jwt>` scheme instead of RFC 8292's
// `vapid t=..,k=..`. Since both HTTP framing details are spec requirements here, this
// implementation follows the RFCs directly. Correctness is verified in
// webpush.test.ts against the literal byte vectors in RFC 8291 Appendix A.
import type { Env } from "./index";

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * SubtleCrypto's TypeScript types require an `ArrayBuffer`-backed view specifically
 * (not the wider `ArrayBufferLike`, which also covers `SharedArrayBuffer`), but
 * `Uint8Array.prototype.slice`/`btoa` round-trips and other helpers above produce views
 * typed as `Uint8Array<ArrayBufferLike>`. This copies into a fresh, plain-ArrayBuffer
 * view to satisfy that constraint at each SubtleCrypto call site.
 */
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toBufferSource(data));
  return new Uint8Array(sig);
}

/**
 * Builds the RFC 8292 VAPID JWT (ES256, aud = push endpoint origin, exp <= 24h from
 * now, sub = mailto:<contact>) and signs it with the application server's ECDSA
 * private key (imported from PKCS8, as produced by scripts/generate-vapid.mjs).
 */
async function buildVapidJwt(
  endpoint: string,
  vapidPrivateKeyB64: string,
  subject: string,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h, well within the 24h ceiling
    sub: subject,
  };

  const encoder = new TextEncoder();
  const headerB64 = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKeyBytes = base64urlDecode(vapidPrivateKeyB64);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toBufferSource(privateKeyBytes),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // WebCrypto's ECDSA signature is the raw (r || s) IEEE P1363 format required by
  // JWS ES256 - no ASN.1 DER conversion needed.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    toBufferSource(encoder.encode(signingInput)),
  );

  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

/**
 * RFC 8291 §3.3 + RFC 8188 key derivation: combines the ECDH shared secret with the
 * subscription's auth secret to derive the content-encryption key and nonce. Exported
 * (module-private via re-export in tests) so webpush.test.ts can verify each
 * intermediate value against the literal bytes in RFC 8291 Appendix A.
 */
async function deriveContentEncryptionParams(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublicKeyBytes: Uint8Array,
  asPublicKeyBytes: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array; ikm: Uint8Array }> {
  const encoder = new TextEncoder();

  // -- RFC 8291 §3.3: combine ECDH secret with the subscription's auth secret --
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes(
    encoder.encode("WebPush: info"),
    new Uint8Array([0x00]),
    uaPublicKeyBytes,
    asPublicKeyBytes,
  );
  const ikm = (await hmacSha256(prkKey, concatBytes(keyInfo, new Uint8Array([0x01])))).slice(0, 32);

  // -- RFC 8188 HKDF: derive CEK and nonce from (salt, IKM) --
  const prk = await hmacSha256(salt, ikm);
  const cekInfo = concatBytes(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0x00]));
  const cek = (await hmacSha256(prk, concatBytes(cekInfo, new Uint8Array([0x01])))).slice(0, 16);
  const nonceInfo = concatBytes(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0x00]));
  const nonce = (await hmacSha256(prk, concatBytes(nonceInfo, new Uint8Array([0x01])))).slice(0, 12);

  return { cek, nonce, ikm };
}

async function aesGcmEncrypt(cek: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  // Single-record message: append the 0x02 padding delimiter (no further padding).
  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey("raw", toBufferSource(cek), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(nonce) },
    cekKey,
    toBufferSource(paddedPlaintext),
  );
  return new Uint8Array(ciphertext);
}

function aes128gcmHeader(salt: Uint8Array, keyId: Uint8Array): Uint8Array {
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  return concatBytes(salt, recordSize, new Uint8Array([keyId.length]), keyId);
}

async function encryptPayload(
  plaintext: Uint8Array,
  subscription: PushSubscriptionKeys,
): Promise<Uint8Array> {
  const uaPublicKeyBytes = base64urlDecode(subscription.p256dh);
  const authSecret = base64urlDecode(subscription.auth);

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(uaPublicKeyBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", asKeyPair.publicKey),
  );

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    asKeyPair.privateKey,
    256,
  );
  const ecdhSecret = new Uint8Array(sharedSecretBits);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const { cek, nonce } = await deriveContentEncryptionParams(
    ecdhSecret,
    authSecret,
    uaPublicKeyBytes,
    asPublicKeyBytes,
    salt,
  );

  const ciphertext = await aesGcmEncrypt(cek, nonce, plaintext);

  return concatBytes(aes128gcmHeader(salt, asPublicKeyBytes), ciphertext);
}

/**
 * Derives an ECDH shared secret given one side's raw private scalar `d` plus its OWN
 * public point (both as given directly by RFC 8291 Appendix A's test vectors, which
 * publish raw scalars rather than PKCS8) and the peer's raw uncompressed public key
 * (0x04 || X || Y). Imports the private key as a JWK since that's the only
 * SubtleCrypto import format that accepts a bare scalar without ASN.1/PKCS8 wrapping;
 * JWK import requires x/y to validate the point is consistent with d, so the owning
 * key's own public point must be supplied (not the peer's).
 */
async function ecdhSharedSecret(
  ownPrivateScalarB64url: string,
  ownPublicKeyRaw: Uint8Array,
  peerPublicKeyRaw: Uint8Array,
): Promise<Uint8Array> {
  const peerPublicKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(peerPublicKeyRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64urlEncode(ownPublicKeyRaw.slice(1, 33)),
      y: base64urlEncode(ownPublicKeyRaw.slice(33, 65)),
      d: base64urlEncode(base64urlDecode(ownPrivateScalarB64url)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  return new Uint8Array(bits);
}

// Exposed for byte-exact verification against RFC 8291 Appendix A test vectors.
export const __testing = {
  base64urlEncode,
  base64urlDecode,
  hmacSha256,
  deriveContentEncryptionParams,
  aesGcmEncrypt,
  aes128gcmHeader,
  ecdhSharedSecret,
};

export type SendPushResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      expired: boolean;
      /**
       * The push service's own explanation, truncated.
       *
       * Discarded until 2026-08-31, which is why a real 400 from Apple was indistinguishable
       * from every other reason a notification might not arrive. A status code alone does not
       * name a cause — 400 covers a malformed JWT, a bad `k=`, a body the service will not
       * accept, and more. The body says which. It said `VapidPkHashMismatch`.
       */
      detail: string;
    };

/** Push services answer with a short reason string; anything longer is not worth a log line. */
const MAX_FAILURE_DETAIL = 200;

/**
 * Apple's reason for "this subscription was created with a different application server key".
 *
 * A push subscription is bound to the VAPID public key that created it, permanently. Replace the
 * key pair and every subscription taken out under the old one is refused forever — with a 400,
 * not the 404/410 that means "gone", so nothing in the expiry path caught it. Production's single
 * subscription (registered 2026-08-10) had been failing this way with the reason discarded.
 *
 * Matched on the body rather than the status because the status is shared with several unrelated
 * causes, and matched narrowly rather than treating every 403/400 as fatal: this branch DELETES
 * the row, so a bad `VAPID_PUBLIC_KEY` of our own would sign every user out of notifications at
 * once. That is recoverable — she re-enables in Settings — but it should never happen quietly,
 * which is why it logs under its own name.
 */
const VAPID_KEY_MISMATCH = "VapidPkHashMismatch";

// RFC 8291's aes128gcm framing adds a fixed 86-byte header (16 salt + 4 record-size +
// 1 keyid-len + 65 keyid) plus a 16-byte GCM tag and a 1-byte padding delimiter to the
// plaintext, and push services commonly cap the encrypted body at 4096 bytes (the
// record size this implementation declares). Rejecting oversized plaintext up front
// gives a clear error instead of a confusing rejection from the push service.
const MAX_PAYLOAD_BYTES = 3800;

/**
 * Sends a Web Push message: builds the RFC 8292 VAPID Authorization header and the
 * RFC 8291 aes128gcm-encrypted body, then POSTs to the subscription's push service
 * endpoint. Returns `expired: true` on 404/410 so the caller can drop the dead
 * subscription row.
 */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: unknown,
  env: Env,
): Promise<SendPushResult> {
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const vapidPublicKey = env.VAPID_PUBLIC_KEY;
  if (!vapidPrivateKey || !vapidPublicKey) {
    throw new Error("VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY must be configured to send push");
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Push payload too large: ${plaintext.byteLength} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte pre-encryption limit`,
    );
  }

  const subject = env.VAPID_CONTACT ?? "mailto:korlogan94@gmail.com";
  const jwt = await buildVapidJwt(subscription.endpoint, vapidPrivateKey, subject);
  const body = await encryptPayload(plaintext, subscription);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "300",
    },
    body: toBufferSource(body),
  });

  if (res.ok) return { ok: true };

  // The one place a failed push leaves a trace. Every caller used to swallow a non-expiry
  // failure silently: nothing in D1 and nothing in the logs, so "the alert never arrived" and
  // "the push service rejected it" looked identical from the outside. `observability` is on in
  // wrangler.jsonc, so this lands in Workers Logs.
  //
  // Host only, never the full endpoint — the path segment is the subscription's bearer
  // credential and would be readable by anyone with log access.
  const host = (() => {
    try {
      return new URL(subscription.endpoint).host;
    } catch {
      return "unparseable-endpoint";
    }
  })();
  // A body this side of the wire is the service's error text, not user data. Reading it cannot
  // fail the send — it has already failed — so a body that will not decode is not worth
  // throwing over.
  const detail = await res
    .text()
    .then((text) => text.trim().slice(0, MAX_FAILURE_DETAIL))
    .catch(() => "");

  // 404/410 mean the subscription is gone. A key mismatch means it still exists and can never
  // work again, which for the caller is the same instruction: drop the row, so the app stops
  // retrying it every cron and reports her as unsubscribed instead of silently broken.
  const keyMismatch = detail.includes(VAPID_KEY_MISMATCH);
  const expired = res.status === 404 || res.status === 410 || keyMismatch;

  console.warn(
    keyMismatch
      ? `[push] subscription was taken out under a different VAPID key — dropping it. host=${host} status=${res.status}`
      : `[push] send failed status=${res.status} host=${host} detail=${detail || "(empty)"}`,
  );

  return { ok: false, status: res.status, expired, detail };
}

import { useState } from "react";
import type { InvitePreview } from "@danyeowa/shared";
import { authClient } from "./auth-client";
import GoogleButton from "./GoogleButton";

type Props = {
  onSignedIn: () => void;
  /** Set when the visitor arrived on an invite link. Replaces the sample departure board with
   * who invited them and what signing in gets them — an anonymous form gives someone no reason
   * to trust it. Carries nothing about the roster; see the route in worker/src/crew.ts. */
  invite?: InvitePreview | null;
  /** Where Google sends the browser back to. Defaults to the app. An invite page passes its own
   * URL: the round trip through Google is a full navigation, so anything the page knew — which
   * invitation this is, whether it matches — is gone unless the return lands back here. */
  callbackURL?: string;
};

/** The sign-in surface, served at `/signin` and reused by `InviteLanding`: wordmark, a static
 * "next duty" departure-board sample, and the OTP form beneath it. The email step and the
 * code step live on this one surface — the code field simply appears under the email field
 * once a code has been sent.
 *
 * The marketing pitch that used to sit in the middle of this screen now has its own route
 * (`Marketing.tsx` at `/`). It left because the two jobs want opposite lengths: explaining the
 * app wants room, and signing in wants the form above the fold. Whichever went second lost. */
export default function Landing({
  onSignedIn,
  invite,
  callbackURL = "/",
}: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { error: sendError } =
        await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "sign-in",
        });
      if (sendError) {
        setError(sendError.message ?? "Failed to send code");
        return;
      }
      setCodeSent(true);
    } catch {
      setError("Couldn't send the code — check your connection");
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.emailOtp({
        email,
        otp: code,
      });
      if (signInError) {
        setError(signInError.message ?? "Failed to sign in");
        return;
      }
      onSignedIn();
    } catch {
      setError("Sign-in failed — try again");
    }
  }

  return (
    <div className="entrance flex w-full max-w-sm flex-col items-center gap-6 text-center">
      <div className="stagger-1 flex flex-col gap-2">
        {/* The wordmark is the way back to the pitch, since `/signin` carries nothing else that
            explains the app. NOT a link for an invited guest: `/` would take them away from the
            invitation they arrived on, and the token is not in the path they would land on. */}
        <h1 className="text-3xl font-semibold text-ink">
          {invite ? (
            "danyeowa"
          ) : (
            <a
              href="/"
              className="inline-flex min-h-[44px] items-center transition-colors duration-[120ms] hover:text-accent"
            >
              danyeowa
            </a>
          )}
        </h1>
        {/* Hidden for an invited guest: the panel below already opens with "X shared their
            roster with you", a better first line than any tagline, and 2026-09-02 recorded
            that someone who arrived by invitation is not to be sold to. */}
        {!invite && (
          <p className="text-lg text-ink-muted">
            A cabin-crew roster the people at home can read too.
          </p>
        )}
      </div>

      {invite ? (
        <div
          data-testid="invite-preview"
          className="stagger-2 flex w-full flex-col gap-3 rounded-lg border border-accent bg-accent-soft p-4 text-left"
        >
          <p className="text-lg font-semibold text-ink">
            {invite.fromName} shared their roster with you
          </p>
          <ul className="flex flex-col gap-1 text-sm text-ink-muted">
            <li>When they report — the start of their day</li>
            <li>When they land — when to leave to collect them</li>
            <li>Which days they're free</li>
          </ul>
          <p className="text-sm text-ink-muted">
            Sign in with{" "}
            <span className="num text-ink">{invite.toEmailMasked}</span> to
            accept.
          </p>
        </div>
      ) : (
        /* Departure-board panel: static illustrative sample, not live schedule data. It stays
          visually dark in both the light and dark app themes on purpose — it's meant to read
          as a physical airport board, not as themed app chrome — so it uses fixed color values
          instead of the ink/card/edge tokens, which flip between themes. */
        <div className="stagger-2 flex w-full flex-col gap-1 rounded-lg border border-white/10 bg-[#0b0d12] p-4 text-left shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-white/50">
            Next duty
          </p>
          <dl className="num flex flex-col text-sm text-white/90">
            <div className="flex items-baseline justify-between border-b border-dashed border-white/15 py-1.5">
              <dt className="text-white/50">EK448</dt>
              <dd>DXB → AKL</dd>
            </div>
            <div className="flex items-baseline justify-between border-b border-dashed border-white/15 py-1.5">
              <dt className="text-white/50">DEP</dt>
              <dd>10:45</dd>
            </div>
            <div className="flex items-baseline justify-between border-b border-dashed border-white/15 py-1.5">
              <dt className="text-white/50">LANDS</dt>
              <dd>
                06:20<sup>+1</sup>
              </dd>
            </div>
            {/* The row here used to read REPORT, and it was arguing with the copy underneath it:
                report came off the day card in 829b673 because a crew member reads it in her
                airline's own app, and the pitch below now says exactly that. The hero should
                lead with what this app adds, which is the free window.

                Fixed amber, matching the dark theme's --color-report, for the same reason the
                panel itself is dark in both themes: this is the value the screen exists for. */}
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-white/50">FREE</dt>
              <dd className="text-[#ffd57e]">22h 35m</dd>
            </div>
          </dl>
        </div>
      )}
      <form
        onSubmit={codeSent ? handleSignIn : handleSendCode}
        className="stagger-3 flex w-full flex-col gap-3 text-left"
      >
        <label htmlFor="landing-email" className="text-sm text-ink-muted">
          Email
        </label>
        <input
          id="landing-email"
          type="email"
          autoComplete="email"
          required
          disabled={codeSent}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-edge bg-raised px-3 py-3 text-ink outline-none transition-colors duration-[120ms] focus:border-accent disabled:opacity-60"
        />

        {!codeSent ? (
          <button
            type="submit"
            className="rounded bg-accent px-3 py-3 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98]"
          >
            Send code
          </button>
        ) : (
          <>
            <p className="text-sm text-ink-muted">Code sent to {email}</p>
            <label htmlFor="landing-code" className="text-sm text-ink-muted">
              Code
            </label>
            <input
              id="landing-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="num rounded border border-edge bg-raised px-3 py-3 text-ink outline-none transition-colors duration-[120ms] focus:border-accent"
            />
            <button
              type="submit"
              className="rounded bg-accent px-3 py-3 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98]"
            >
              Sign in
            </button>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-ink-muted">
            {error}
          </p>
        )}
      </form>

      <div className="flex w-full items-center gap-2 text-xs text-ink-muted">
        <span className="h-px flex-1 bg-edge" aria-hidden="true" />
        or
        <span className="h-px flex-1 bg-edge" aria-hidden="true" />
      </div>

      <GoogleButton callbackURL={callbackURL} onError={setError} />
    </div>
  );
}

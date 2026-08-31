import { useEffect, useRef, useState } from "react";
import {
  SessionTooOldError,
  deleteAccount,
  getPushConfig,
  subscribePush,
  unsubscribePush,
  sendTestNotification,
  updateNotificationPrefs,
} from "./api";
import { getAirlinePrefix, setAirlinePrefix } from "./lib/airlinePrefix";
import {
  isInstallPromptAvailable,
  isIos,
  isRunningStandalone,
  onInstallPromptAvailable,
  showInstallPrompt,
} from "./lib/install";
import { urlBase64ToUint8Array } from "./lib/push";
import { getStoredTheme, setTheme } from "./theme";
import type { Theme } from "./theme";

type Props = {
  email: string;
  onSignOut: () => void;
};

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LEAD_OPTIONS: { value: number; label: string }[] = [
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 180, label: "3h" },
];

function pushSupported(): boolean {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export default function SettingsView({ email, onSignOut }: Props) {
  // Deletion is irreversible and has no undo, so the confirmation is the person typing their own
  // address — a button they can hit by accident is the wrong shape for this.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (confirmingDelete && !dialog.open) dialog.showModal();
    if (!confirmingDelete && dialog.open) dialog.close();
  }, [confirmingDelete]);
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [airlinePrefix, setAirlinePrefixState] =
    useState<string>(getAirlinePrefix);

  const [supported] = useState(pushSupported);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    () => (pushSupported() ? Notification.permission : null),
  );
  const [subscribed, setSubscribed] = useState(false);
  const [leadMinutes, setLeadMinutes] = useState(120);
  const [arrivalEnabled, setArrivalEnabled] = useState(true);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const [installAvailable, setInstallAvailable] = useState(
    isInstallPromptAvailable,
  );
  const [standalone] = useState(isRunningStandalone);

  useEffect(() => {
    if (standalone) return;
    return onInstallPromptAvailable(() => setInstallAvailable(true));
  }, [standalone]);

  async function handleInstall() {
    const accepted = await showInstallPrompt();
    if (accepted) setInstallAvailable(false);
  }

  useEffect(() => {
    if (!supported) return;
    getPushConfig()
      .then((config) => {
        setSubscribed(config.subscribed);
        setLeadMinutes(config.leadMinutes);
        setArrivalEnabled(config.arrivalEnabled);
      })
      .catch(() => {
        // Leave defaults in place — the toggle simply starts off.
      });
  }, [supported]);

  function selectTheme(next: Theme) {
    setThemeState(next);
    setTheme(next);
  }

  function changeAirlinePrefix(next: string) {
    const upper = next.toUpperCase();
    setAirlinePrefixState(upper);
    setAirlinePrefix(upper);
  }

  async function handleToggleOn() {
    setPushError(null);
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== "granted") return;

    try {
      const config = await getPushConfig();
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        setPushError("Couldn't enable notifications — try again");
        return;
      }

      // Tear down any subscription this browser is still holding before taking out a new one.
      //
      // A subscription is bound to the VAPID key that created it. If that key has since been
      // replaced, `subscribe()` with the current key does NOT re-key it — it throws
      // InvalidStateError, which this function's catch turns into "try again", forever. That is
      // the dead end waiting for anyone whose subscription predates a key change, and it is
      // exactly the state production's one device was in on 2026-08-31 (Apple was answering
      // `VapidPkHashMismatch`).
      //
      // Unconditional rather than comparing keys: this only runs when she taps enable, and
      // `applicationServerKey` comes back as an ArrayBuffer that has to be re-encoded to compare
      // against the served string. Dropping and re-taking is the smaller, surer path. The server
      // row goes with it, or the old endpoint would linger and be pushed to forever.
      const stale = await registration.pushManager.getSubscription();
      if (stale) {
        // Best effort on the server row: it may already be gone (the scan deletes a subscription
        // the push service has rejected as un-keyed), and that must not stop her re-subscribing.
        try {
          await unsubscribePush(stale.endpoint);
        } catch {
          // Nothing to do — the local unsubscribe below is the part that must happen.
        }
        await stale.unsubscribe();
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
      const json = subscription.toJSON();
      await subscribePush({
        endpoint: json.endpoint!,
        keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! },
      });
      setSubscribed(true);
    } catch {
      setPushError("Couldn't enable notifications — try again");
    }
  }

  async function handleToggleOff() {
    setPushError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      setPushError("Couldn't disable notifications — try again");
    }
  }

  async function handleLeadChange(next: number) {
    setLeadMinutes(next);
    try {
      await updateNotificationPrefs({ enabled: true, leadMinutes: next });
    } catch {
      setPushError("Couldn't save your lead time — try again");
    }
  }

  /**
   * Sends a real push to this account's devices and reports the counts.
   *
   * The endpoint has existed since push shipped; nothing ever called it. Without it "I'm not
   * getting notifications" has no first step — the report scan only fires near a real duty, so
   * waiting is the only other test, and a silent phone looks identical whether the send never
   * happened, the subscription was dead, or the device swallowed it. The counts separate those.
   */
  async function handleSendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestNotification();
      if (result.subscriptions === 0) {
        setTestResult("This device isn't subscribed yet — turn reminders on above.");
      } else if (result.sent > 0) {
        setTestResult(
          `Sent to ${result.sent} of ${result.subscriptions} device(s). Nothing shown? The device is holding it back, not the app.`,
        );
      } else if (result.expiredRemoved) {
        setTestResult(
          `${result.expiredRemoved} subscription(s) had expired and were removed — turn reminders off and on again to re-subscribe.`,
        );
      } else {
        const codes = result.failedWithStatus?.join(", ");
        setTestResult(`The push service refused it${codes ? ` (HTTP ${codes})` : ""}.`);
      }
    } catch {
      setTestResult("Couldn't reach the server — try again.");
    } finally {
      setTesting(false);
    }
  }

  async function handleArrivalToggle(next: boolean) {
    setArrivalEnabled(next);
    try {
      await updateNotificationPrefs({
        enabled: true,
        leadMinutes,
        arrivalEnabled: next,
      });
    } catch {
      // Put the switch back rather than leaving it showing a setting the server never took.
      setArrivalEnabled(!next);
      setPushError("Couldn't save arrival alerts — try again");
    }
  }

  return (
    <div className="entrance flex w-full max-w-xl flex-col gap-6">
      <div className="stagger-1 flex flex-col gap-1 rounded-lg border border-edge bg-card p-4">
        <p className="text-xs uppercase text-ink-muted">Signed in as</p>
        <p className="text-ink">{email}</p>
      </div>

      <fieldset className="stagger-2 flex flex-col gap-2 rounded-lg border border-edge bg-card p-4">
        <legend className="px-1 text-xs uppercase text-ink-muted">Theme</legend>
        {THEME_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-2 text-ink"
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={theme === option.value}
              onChange={() => selectTheme(option.value)}
              className="accent-accent"
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <div className="stagger-3 flex flex-col gap-3 rounded-lg border border-edge bg-card p-4">
        <p className="px-1 text-xs uppercase text-ink-muted">Notifications</p>

        {!supported ? (
          <p className="text-sm text-ink-muted" data-testid="push-unsupported">
            Install to Home Screen to enable notifications
          </p>
        ) : permission === "denied" ? (
          <p className="text-sm text-ink-muted">
            Notifications are blocked for this site — enable them in your
            browser settings to get report-time reminders.
          </p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-2 text-ink">
              <span>Report-time reminders</span>
              <input
                type="checkbox"
                data-testid="push-toggle"
                checked={subscribed}
                onChange={(e) =>
                  e.target.checked ? handleToggleOn() : handleToggleOff()
                }
                className="accent-accent"
              />
            </label>

            {subscribed && (
              <label className="flex items-center justify-between gap-2 text-ink">
                <span>Remind me</span>
                <select
                  data-testid="push-lead"
                  value={leadMinutes}
                  onChange={(e) => handleLeadChange(Number(e.target.value))}
                  className="rounded border border-edge bg-ground px-2 py-1"
                >
                  {LEAD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {subscribed && (
              <label className="flex items-center justify-between gap-2 text-ink">
                <span>
                  Arrival alerts
                  <span className="block text-sm text-ink-muted">
                    1 hour, 30 minutes, and on landing
                  </span>
                </span>
                <input
                  type="checkbox"
                  data-testid="arrival-alerts-toggle"
                  checked={arrivalEnabled}
                  onChange={(e) => handleArrivalToggle(e.target.checked)}
                  className="h-6 w-6 accent-accent"
                />
              </label>
            )}

            {subscribed && (
              <div className="flex flex-col gap-2 border-t border-edge pt-3">
                <button
                  type="button"
                  data-testid="push-test"
                  onClick={handleSendTest}
                  disabled={testing}
                  className="flex min-h-[44px] items-center justify-center rounded-md border border-edge text-sm text-accent transition-colors duration-[120ms] hover:border-accent disabled:opacity-60"
                >
                  {testing ? "Sending…" : "Send a test notification"}
                </button>
                {testResult && (
                  <p data-testid="push-test-result" className="text-sm text-ink-muted">
                    {testResult}
                  </p>
                )}
              </div>
            )}

            {pushError && <p className="text-sm text-danger">{pushError}</p>}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-edge bg-card p-4">
        <p className="px-1 text-xs uppercase text-ink-muted">App</p>

        <label className="flex items-center justify-between gap-2 text-ink">
          <span>Airline</span>
          <input
            type="text"
            maxLength={2}
            data-testid="airline-prefix-input"
            value={airlinePrefix}
            onChange={(e) => changeAirlinePrefix(e.target.value)}
            className="num w-16 rounded border border-edge bg-ground px-2 py-1 uppercase"
          />
        </label>
        <p className="text-sm text-ink-muted">
          Flight numbers are entered as {airlinePrefix}···
        </p>

        {standalone ? (
          <p className="text-sm text-ink-muted" data-testid="installed-badge">
            Installed ✓
          </p>
        ) : installAvailable ? (
          <button
            type="button"
            data-testid="install-button"
            onClick={handleInstall}
            className="self-start rounded border border-accent px-3 py-2 text-accent transition-colors duration-[120ms] hover:bg-accent/10"
          >
            Install app
          </button>
        ) : isIos() ? (
          <p className="text-sm text-ink-muted" data-testid="install-hint-ios">
            Install: Share → Add to Home Screen
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-edge bg-card p-4">
        <p className="text-xs uppercase text-ink-muted">Home base</p>
        <p className="text-ink">DXB · default</p>
        <p className="text-sm text-ink-muted">customizable later</p>
      </div>

      <button
        type="button"
        onClick={onSignOut}
        className="self-start rounded border border-danger px-3 py-2 text-danger transition-colors duration-[120ms] hover:bg-danger/10"
      >
        Sign out
      </button>

      <div className="flex flex-col gap-2 rounded-lg border border-edge bg-card p-4">
        <p className="px-1 text-xs uppercase text-ink-muted">Danger zone</p>
        <p className="text-sm text-ink-muted">
          Deleting your account removes your roster, your crew links and your
          sign-in. It cannot be undone.
        </p>
        <button
          type="button"
          data-testid="delete-account"
          onClick={() => {
            setTypedEmail("");
            setDeleteError(null);
            setConfirmingDelete(true);
          }}
          className="min-h-[44px] self-start rounded border border-danger px-3 py-2 text-danger transition-colors duration-[120ms] hover:bg-danger/10"
        >
          Delete account
        </button>
      </div>

      {/* Native <dialog>, same as the duty-delete confirm: showModal() gives the focus trap, Esc
          and the inert background for free. Mounted only while open, because jsdom implements
          neither showModal nor close and a permanently mounted one breaks the unit suite. */}
      {confirmingDelete ? (
        <dialog
          ref={deleteDialogRef}
          data-testid="delete-account-dialog"
          aria-labelledby="delete-account-title"
          onClose={() => setConfirmingDelete(false)}
          onClick={(e) => {
            if (e.target === deleteDialogRef.current)
              setConfirmingDelete(false);
          }}
          className="max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-card p-5 text-ink backdrop:bg-black/50"
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p
                id="delete-account-title"
                className="text-lg font-semibold text-ink"
              >
                Delete your account?
              </p>
              <p className="text-sm text-ink-muted">
                This removes your roster, your crew links and your sign-in. It
                cannot be undone.
              </p>
            </div>

            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Type <span className="num text-ink">{email}</span> to confirm
              <input
                type="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-testid="delete-account-confirm-input"
                value={typedEmail}
                onChange={(e) => setTypedEmail(e.target.value)}
                className="num rounded border border-edge bg-raised px-3 py-3 text-ink outline-none transition-colors duration-[120ms] focus:border-danger"
              />
            </label>

            {deleteError ? (
              <p role="alert" className="text-sm text-danger">
                {deleteError}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="min-h-[48px] rounded border border-edge px-4 py-2 text-ink transition-colors duration-[120ms] hover:border-ink-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-delete-account"
                // Compared case-insensitively and trimmed: the address is a fact they are
                // confirming, not a password, and failing someone for a capital letter or a
                // trailing space would just teach them to paste it.
                disabled={
                  deleting ||
                  typedEmail.trim().toLowerCase() !== email.toLowerCase()
                }
                onClick={async () => {
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await deleteAccount();
                    // The session is already gone server-side; this clears the client's copy and
                    // returns to the signed-out screen.
                    onSignOut();
                  } catch (err) {
                    setDeleteError(
                      err instanceof SessionTooOldError
                        ? "For safety this needs a recent sign-in. Sign out, sign back in, and try again."
                        : "Couldn't delete the account — check your connection and try again.",
                    );
                    setDeleting(false);
                  }
                }}
                className="min-h-[48px] rounded bg-danger px-4 py-2 font-medium text-ground transition-[background-color,transform] duration-[120ms] hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}

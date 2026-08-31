import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import * as api from "./api";
import { getAirlinePrefix } from "./lib/airlinePrefix";
import * as theme from "./theme";

vi.mock("./api", () => ({
  getPushConfig: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  updateNotificationPrefs: vi.fn(),
  deleteAccount: vi.fn(),
  // Declared inside the factory because vi.mock is hoisted above every top-level binding in
  // this file. A real class, not a stub: SettingsView branches on `instanceof`, so a plain
  // object would make the freshness message untestable and silently take the generic branch.
  SessionTooOldError: class extends Error {},
}));

describe("SettingsView", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the signed-in user's email", () => {
    render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
    expect(screen.getByText("pilot@example.com")).toBeInTheDocument();
  });

  it("shows the home base row as a read-only note", () => {
    render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
    expect(screen.getByText(/DXB/)).toBeInTheDocument();
    expect(screen.getByText(/customizable later/i)).toBeInTheDocument();
  });

  it("reflects the current theme selection, defaulting to System", () => {
    render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /system/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^light$/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^dark$/i })).not.toBeChecked();
  });

  it("calls setTheme when a theme radio is picked", async () => {
    const setThemeSpy = vi.spyOn(theme, "setTheme");
    const user = userEvent.setup();
    render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(setThemeSpy).toHaveBeenCalledWith("dark");

    setThemeSpy.mockRestore();
  });

  it("calls onSignOut when the sign-out button is clicked", async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(<SettingsView email="pilot@example.com" onSignOut={onSignOut} />);

    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  describe("Notifications", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it("shows the install hint when push isn't supported (e.g. iOS Safari, not installed)", () => {
      // No Notification/serviceWorker/PushManager stubbed — jsdom doesn't define them by
      // default, so this is the natural "unsupported" state.
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      expect(screen.getByTestId("push-unsupported")).toHaveTextContent(
        /install to home screen/i,
      );
      expect(screen.queryByTestId("push-toggle")).not.toBeInTheDocument();
    });

    it("shows a muted explanation when permission was previously denied", () => {
      vi.stubGlobal("Notification", {
        permission: "denied",
        requestPermission: vi.fn(),
      });
      vi.stubGlobal("PushManager", class {});
      Object.defineProperty(navigator, "serviceWorker", {
        value: { getRegistration: vi.fn() },
        configurable: true,
      });
      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey: "pubkey",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: false,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      expect(screen.getByText(/blocked for this site/i)).toBeInTheDocument();
      expect(screen.queryByTestId("push-toggle")).not.toBeInTheDocument();
    });

    it("subscribes on toggle-on: requests permission, subscribes pushManager, and POSTs the subscription", async () => {
      // userEvent.setup() must run BEFORE stubbing Notification/serviceWorker: it attaches
      // internal state to the current globals at setup time.
      const user = userEvent.setup();

      const requestPermission = vi.fn().mockResolvedValue("granted");
      vi.stubGlobal("Notification", {
        permission: "default",
        requestPermission,
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey:
          "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: false,
      });

      const subscribe = vi.fn().mockResolvedValue({
        toJSON: () => ({
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
      });
      // Nothing held by this browser yet — the ordinary first-time case.
      const registration = {
        pushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(null) },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { getRegistration: vi.fn().mockResolvedValue(registration) },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const toggle = await screen.findByTestId("push-toggle");
      await user.click(toggle);

      await waitFor(() => expect(requestPermission).toHaveBeenCalled());
      await waitFor(() => expect(subscribe).toHaveBeenCalled());
      expect(subscribe.mock.calls[0]![0]).toMatchObject({
        userVisibleOnly: true,
      });
      await waitFor(() =>
        expect(api.subscribePush).toHaveBeenCalledWith({
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
      );
      await waitFor(() => expect(toggle).toBeChecked());
      expect(await screen.findByTestId("push-lead")).toBeInTheDocument();
    });

    it("drops a subscription this browser is still holding before taking out a new one", async () => {
      // A subscription is bound to the VAPID key that created it. Replace the key pair and
      // `subscribe()` does not re-key the old one — it throws InvalidStateError, which this
      // screen turns into "try again", forever. Production's one device was in exactly that
      // state on 2026-08-31, with Apple answering `VapidPkHashMismatch` to every send.
      const user = userEvent.setup();

      vi.stubGlobal("Notification", {
        permission: "default",
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey:
          "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: false,
      });

      const staleUnsubscribe = vi.fn().mockResolvedValue(true);
      const stale = {
        endpoint: "https://push.example.com/taken-out-under-the-old-key",
        unsubscribe: staleUnsubscribe,
      };
      const subscribe = vi.fn().mockResolvedValue({
        toJSON: () => ({
          endpoint: "https://push.example.com/fresh",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
      });
      const registration = {
        pushManager: { subscribe, getSubscription: vi.fn().mockResolvedValue(stale) },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { getRegistration: vi.fn().mockResolvedValue(registration) },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      await user.click(await screen.findByTestId("push-toggle"));

      // The old endpoint goes from the server too, or it lingers there being pushed to forever.
      await waitFor(() =>
        expect(api.unsubscribePush).toHaveBeenCalledWith(
          "https://push.example.com/taken-out-under-the-old-key",
        ),
      );
      await waitFor(() => expect(staleUnsubscribe).toHaveBeenCalled());
      await waitFor(() =>
        expect(api.subscribePush).toHaveBeenCalledWith({
          endpoint: "https://push.example.com/fresh",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
      );
    });

    it("unsubscribes on toggle-off: DELETEs the subscription and calls unsubscribe()", async () => {
      const user = userEvent.setup();

      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn(),
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey: "pubkey",
        enabled: true,
        leadMinutes: 60,
        arrivalEnabled: true,
        subscribed: true,
      });

      const unsubscribe = vi.fn().mockResolvedValue(true);
      const existingSubscription = {
        endpoint: "https://push.example.com/xyz",
        unsubscribe,
      };
      const registration = {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(existingSubscription),
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { getRegistration: vi.fn().mockResolvedValue(registration) },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const toggle = await screen.findByTestId("push-toggle");
      await waitFor(() => expect(toggle).toBeChecked());

      await user.click(toggle);

      await waitFor(() =>
        expect(api.unsubscribePush).toHaveBeenCalledWith(
          "https://push.example.com/xyz",
        ),
      );
      await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
      await waitFor(() => expect(toggle).not.toBeChecked());
    });

    it("PUTs prefs when the lead-minutes select changes", async () => {
      const user = userEvent.setup();

      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn(),
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey: "pubkey",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: true,
      });
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          getRegistration: vi.fn().mockResolvedValue({ pushManager: {} }),
        },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const select = await screen.findByTestId("push-lead");
      await user.selectOptions(select, "30");

      await waitFor(() =>
        expect(api.updateNotificationPrefs).toHaveBeenCalledWith({
          enabled: true,
          leadMinutes: 30,
        }),
      );
    });

    it("PUTs prefs when arrival alerts are switched off", async () => {
      const user = userEvent.setup();

      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn(),
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey: "pubkey",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: true,
      });
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          getRegistration: vi.fn().mockResolvedValue({ pushManager: {} }),
        },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const toggle = await screen.findByTestId("arrival-alerts-toggle");
      expect(toggle).toBeChecked();
      await user.click(toggle);

      await waitFor(() =>
        expect(api.updateNotificationPrefs).toHaveBeenCalledWith({
          enabled: true,
          leadMinutes: 120,
          arrivalEnabled: false,
        }),
      );
      expect(toggle).not.toBeChecked();
    });

    it("puts the arrival switch back when the save fails", async () => {
      // A switch that stays flipped after a failed save is a lie about what the server holds.
      const user = userEvent.setup();

      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn(),
      });
      vi.stubGlobal("PushManager", class {});

      vi.mocked(api.getPushConfig).mockResolvedValue({
        publicKey: "pubkey",
        enabled: true,
        leadMinutes: 120,
        arrivalEnabled: true,
        subscribed: true,
      });
      vi.mocked(api.updateNotificationPrefs).mockRejectedValueOnce(
        new Error("offline"),
      );
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          getRegistration: vi.fn().mockResolvedValue({ pushManager: {} }),
        },
        configurable: true,
      });

      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const toggle = await screen.findByTestId("arrival-alerts-toggle");
      await user.click(toggle);

      await waitFor(() => expect(toggle).toBeChecked());
      expect(
        screen.getByText(/couldn't save arrival alerts/i),
      ).toBeInTheDocument();
    });
  });

  describe("App (install affordance)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("shows the installed badge when running in standalone display-mode", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      expect(screen.getByTestId("installed-badge")).toHaveTextContent(
        /installed/i,
      );
      expect(screen.queryByTestId("install-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("install-hint-ios")).not.toBeInTheDocument();
    });

    it("shows the iOS hint when not standalone and beforeinstallprompt never fires", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      );
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      expect(screen.getByTestId("install-hint-ios")).toHaveTextContent(
        /add to home screen/i,
      );
      expect(screen.queryByTestId("install-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("installed-badge")).not.toBeInTheDocument();
    });

    it("shows nothing in the App section on a non-iOS browser with no install prompt available", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      expect(screen.queryByTestId("install-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("install-hint-ios")).not.toBeInTheDocument();
      expect(screen.queryByTestId("installed-badge")).not.toBeInTheDocument();
    });

    it("shows the Install app button once beforeinstallprompt fires, and prompts on click", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      expect(screen.queryByTestId("install-button")).not.toBeInTheDocument();

      const prompt = vi.fn().mockResolvedValue(undefined);
      const userChoice = Promise.resolve({ outcome: "accepted" as const });
      const event = new Event("beforeinstallprompt", {
        cancelable: true,
      }) as Event & {
        prompt: typeof prompt;
        userChoice: typeof userChoice;
      };
      event.prompt = prompt;
      event.userChoice = userChoice;
      window.dispatchEvent(event);

      const button = await screen.findByTestId("install-button");
      await user.click(button);

      expect(prompt).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(screen.queryByTestId("install-button")).not.toBeInTheDocument(),
      );
    });
  });

  describe("Airline prefix", () => {
    it("renders the current prefix, defaulting to EK", () => {
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);
      expect(screen.getByTestId("airline-prefix-input")).toHaveValue("EK");
    });

    it("persists a typed prefix", async () => {
      const user = userEvent.setup();
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const input = screen.getByTestId("airline-prefix-input");
      await user.clear(input);
      await user.type(input, "qf");

      expect(getAirlinePrefix()).toBe("QF");
    });

    it("renders lowercase input uppercased", async () => {
      const user = userEvent.setup();
      render(<SettingsView email="pilot@example.com" onSignOut={vi.fn()} />);

      const input = screen.getByTestId("airline-prefix-input");
      await user.clear(input);
      await user.type(input, "qf");

      expect(input).toHaveValue("QF");
    });
  });

  describe("deleting the account", () => {
    const EMAIL = "pilot@example.com";

    async function openDialog() {
      const user = userEvent.setup();
      render(<SettingsView email={EMAIL} onSignOut={vi.fn()} />);
      await user.click(screen.getByTestId("delete-account"));
      return user;
    }

    it("keeps the delete button dead until the exact address is typed", async () => {
      const user = await openDialog();

      const confirm = screen.getByTestId("confirm-delete-account");
      expect(confirm).toBeDisabled();

      await user.type(
        screen.getByTestId("delete-account-confirm-input"),
        "pilot@example.co",
      );
      expect(confirm).toBeDisabled();

      await user.type(screen.getByTestId("delete-account-confirm-input"), "m");
      expect(confirm).toBeEnabled();
    });

    it("accepts the address with different case or stray spaces", async () => {
      // They are confirming a fact they can see on screen, not entering a password. Failing
      // someone over a capital letter only teaches them to paste it.
      const user = await openDialog();
      await user.type(
        screen.getByTestId("delete-account-confirm-input"),
        "  Pilot@Example.com ",
      );
      expect(screen.getByTestId("confirm-delete-account")).toBeEnabled();
    });

    it("deletes, then hands control back to the signed-out screen", async () => {
      const onSignOut = vi.fn();
      const user = userEvent.setup();
      vi.mocked(api.deleteAccount).mockResolvedValue(undefined);
      render(<SettingsView email={EMAIL} onSignOut={onSignOut} />);

      await user.click(screen.getByTestId("delete-account"));
      await user.type(
        screen.getByTestId("delete-account-confirm-input"),
        EMAIL,
      );
      await user.click(screen.getByTestId("confirm-delete-account"));

      await waitFor(() =>
        expect(vi.mocked(api.deleteAccount)).toHaveBeenCalledTimes(1),
      );
      await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
    });

    it("says to sign in again when the session is too old, rather than 'something went wrong'", async () => {
      // better-auth refuses a stale session because there is no password to ask for instead.
      // That is an answer, not a fault, and the person is mid-way through deleting their data —
      // the worst possible moment for a generic error.
      const user = await openDialog();
      vi.mocked(api.deleteAccount).mockRejectedValue(
        new api.SessionTooOldError(),
      );

      await user.type(
        screen.getByTestId("delete-account-confirm-input"),
        EMAIL,
      );
      await user.click(screen.getByTestId("confirm-delete-account"));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /sign in again|recent sign-in/i,
      );
    });

    it("does not sign the user out when the delete failed", async () => {
      const onSignOut = vi.fn();
      const user = userEvent.setup();
      vi.mocked(api.deleteAccount).mockRejectedValue(new Error("network"));
      render(<SettingsView email={EMAIL} onSignOut={onSignOut} />);

      await user.click(screen.getByTestId("delete-account"));
      await user.type(
        screen.getByTestId("delete-account-confirm-input"),
        EMAIL,
      );
      await user.click(screen.getByTestId("confirm-delete-account"));

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(onSignOut).not.toHaveBeenCalled();
    });
  });
});

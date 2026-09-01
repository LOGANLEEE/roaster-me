import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./auth-client", () => ({
  authClient: {
    signOut: vi.fn(),
    emailOtp: { sendVerificationOtp: vi.fn() },
    signIn: { emailOtp: vi.fn() },
  },
}));

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stubSignedOutFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/health")) return Promise.resolve(jsonResponse({ ok: true, d1: true }));
      if (url.includes("/api/me")) return Promise.resolve(jsonResponse({ error: "unauthenticated" }, { status: 401 }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    })
  );
}

function stubSignedInFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/health")) return Promise.resolve(jsonResponse({ ok: true, d1: true }));
      if (url.includes("/api/me")) return Promise.resolve(jsonResponse({ email: "pilot@example.com" }));
      if (url.includes("/api/trips")) return Promise.resolve(jsonResponse({ trips: [] }));
      if (url.includes("/api/crew")) return Promise.resolve(jsonResponse({ members: [], received: [], sent: [] }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    })
  );
}

describe("App", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders nothing until /api/me answers, leaving the boot splash up", async () => {
    // /api/me never settles, so the app stays in its loading state for the whole assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/health")) return Promise.resolve(jsonResponse({ ok: true, d1: true }));
        return new Promise<Response>(() => {});
      })
    );
    const { container } = render(<App />);

    // Nothing at all — an empty #root is what keeps index.html's boot splash on screen
    // (`#root:not(:empty) + #boot-splash` dismisses it). See boot-splash.test.ts.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows title, API status, and the inline sign-in form (one surface, no login screen) when signed out", async () => {
    stubSignedOutFetch();
    render(<App />);
    // Exactly one h1 on the page — the Landing hero — no duplicate with the header chrome.
    // Awaited: the boot splash holds the screen (and owns no h1) until /api/me answers.
    expect(await screen.findAllByRole("heading", { name: /danyeowa/i, level: 1 })).toHaveLength(1);
    expect(await screen.findByText(/api: online/i)).toBeInTheDocument();
    // Email is visible up front, no separate CTA/navigation needed to reach it.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeInTheDocument();
  });

  it("hides the tab bar when signed out", async () => {
    stubSignedOutFetch();
    render(<App />);
    await screen.findByText(/api: online/i);
    expect(screen.queryByTestId("tab-calendar")).not.toBeInTheDocument();
  });

  it("shows the tab bar and defaults to the calendar tab when signed in", async () => {
    stubSignedInFetch();
    render(<App />);
    expect(await screen.findByTestId("tab-calendar")).toBeInTheDocument();
    expect(screen.getByTestId("tab-calendar").className).toContain("text-accent");
    // An empty roster lands on today's own day card, not on a "No trips yet" panel — that
    // panel's button only selected today, which is the card already on screen.
    expect(await screen.findByTestId("day-detail-card")).toHaveTextContent(/no duty/i);
  });

  it("switches views when a tab is clicked", async () => {
    stubSignedInFetch();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("tab-calendar");

    await user.click(screen.getByTestId("tab-share"));
    expect(await screen.findByTestId("crew-panel")).toBeInTheDocument();

    await user.click(screen.getByTestId("tab-settings"));
    expect(await screen.findByText("pilot@example.com")).toBeInTheDocument();
  });

  it("no longer shows email/sign-out in the header - they live in Settings", async () => {
    stubSignedInFetch();
    render(<App />);
    await screen.findByTestId("tab-calendar");
    expect(screen.queryByText("pilot@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("signs out from the Settings tab", async () => {
    stubSignedInFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("tab-settings"));

    await user.click(await screen.findByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /danyeowa/i, level: 1 })).toBeInTheDocument();
  });
});

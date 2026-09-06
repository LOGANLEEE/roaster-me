import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Landing from "./Landing";
import { authClient } from "./auth-client";

vi.mock("./auth-client", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: vi.fn() },
    signIn: { emailOtp: vi.fn(), social: vi.fn() },
  },
}));

describe("Landing", () => {
  beforeEach(() => {
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockReset();
    vi.mocked(authClient.signIn.emailOtp).mockReset();
    vi.mocked(authClient.signIn.social).mockReset();
  });

  it("renders the wordmark and the departure-board sample", () => {
    render(<Landing onSignedIn={() => {}} />);
    expect(screen.getByRole("heading", { name: /danyeowa/i })).toBeInTheDocument();
    expect(screen.getByText(/next duty/i)).toBeInTheDocument();
    expect(screen.getByText("EK448")).toBeInTheDocument();
    expect(screen.getByText(/dxb.*akl/i)).toBeInTheDocument();
  });

  // The pitch moved to Marketing.tsx at `/` on 2026-09-04; this surface is sign-in only, so
  // the tagline is all the explanation it carries.
  it("carries the tagline but no marketing pitch", () => {
    render(<Landing onSignedIn={() => {}} />);
    expect(screen.getByText(/a cabin-crew roster the people at home can read too/i))
      .toBeInTheDocument();
    expect(screen.queryByTestId("marketing")).not.toBeInTheDocument();
    expect(screen.queryByText(/the roster is written for the airline/i)).not.toBeInTheDocument();
  });

  // 2026-09-02 recorded that an invited guest must not be sold to — they arrived because a
  // named person shared a roster with them, which beats any tagline.
  it("drops the tagline for someone arriving on an invite", () => {
    render(
      <Landing
        onSignedIn={() => {}}
        invite={{ fromName: "Isis", toEmailMasked: "k\u2022\u2022\u2022\u202294@gmail.com" }}
      />,
    );
    expect(screen.getByText(/isis shared their roster with you/i)).toBeInTheDocument();
    expect(screen.queryByText(/a cabin-crew roster the people at home can read too/i))
      .not.toBeInTheDocument();
  });

  it("sends the wordmark back to the pitch, except for an invited guest", () => {
    const { unmount } = render(<Landing onSignedIn={() => {}} />);
    // `/signin` carries no other explanation of what the app is, so the wordmark is the way back.
    expect(screen.getByRole("link", { name: /danyeowa/i })).toHaveAttribute("href", "/");
    unmount();

    render(
      <Landing
        onSignedIn={() => {}}
        invite={{ fromName: "Isis", toEmailMasked: "k\u2022\u2022\u202294@gmail.com" }}
      />,
    );
    // `/` would take them away from the invitation they arrived on, and the token is not in the
    // path they would land on.
    expect(screen.queryByRole("link", { name: /danyeowa/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /danyeowa/i, level: 1 })).toBeInTheDocument();
  });

  it("shows the email field (and no separate login screen) up front", () => {
    render(<Landing onSignedIn={() => {}} />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
  });

  it("signs in with Google when the Google button is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.signIn.social).mockResolvedValue({
      data: {},
      error: null,
    } as never);

    render(<Landing onSignedIn={() => {}} />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
  });

  it("sends an OTP for the entered email, then shows the code field inline and signs in", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    const onSignedIn = vi.fn();

    render(<Landing onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText(/email/i), "roast@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "roast@example.com",
      type: "sign-in",
    });

    // Code field appears on the same surface, directly under email — no navigation.
    expect(await screen.findByText(/code sent to roast@example.com/i)).toBeInTheDocument();
    const codeInput = screen.getByLabelText(/code/i);
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
      email: "roast@example.com",
      otp: "123456",
    });
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("shows a fallback error when sendVerificationOtp throws", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockRejectedValue(new Error("network down"));
    const onSignedIn = vi.fn();

    render(<Landing onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText(/email/i), "roast@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't send the code — check your connection/i
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("shows a fallback error when signIn.emailOtp throws", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      data: {},
      error: null,
    } as never);
    vi.mocked(authClient.signIn.emailOtp).mockRejectedValue(new Error("network down"));
    const onSignedIn = vi.fn();

    render(<Landing onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText(/email/i), "roast@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    const codeInput = await screen.findByLabelText(/code/i);
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/sign-in failed — try again/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

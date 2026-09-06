import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Marketing from "./Marketing";

describe("Marketing", () => {
  it("names the problem before it names the product", () => {
    render(<Marketing />);
    expect(
      screen.getByRole("heading", { name: /the roster is written for the airline/i }),
    ).toBeInTheDocument();
  });

  it("carries the four content blocks the page exists for", () => {
    render(<Marketing />);
    // How it works — the entry cost of the product, and the thing the old page never said.
    expect(screen.getByText(/type a flight number/i)).toBeInTheDocument();
    expect(screen.getByText(/the schedule fills itself in/i)).toBeInTheDocument();
    expect(screen.getByText(/invite one person/i)).toBeInTheDocument();
    // Arrival alerts.
    expect(screen.getByText("60 · 30 · 0")).toBeInTheDocument();
    // Free, and the objection every crew member has.
    expect(screen.getByText(/never asks for your crew-portal password/i)).toBeInTheDocument();
    // Footer: what happens to the data.
    expect(screen.getByText(/it is not sold/i)).toBeInTheDocument();
  });

  it("carries no claim that docs/FEATURES.md marks as merely Built", () => {
    const { container } = render(<Marketing />);
    const text = container.textContent ?? "";
    // Report-time alerts and live status are Built, not verified in production. "Share a roster
    // by link" was removed on 2026-08-14. None of the three may be promised to a stranger.
    expect(text).not.toMatch(/report time|report-time alert/i);
    expect(text).not.toMatch(/live status|track the flight|real[- ]time/i);
    expect(text).not.toMatch(/share (a )?(roster )?(by )?link|shareable link/i);
  });

  it("does not assume the crew member is a woman", () => {
    const { container } = render(<Marketing />);
    // The old second audience card read "When she is back, and where she is now", which tells
    // half the people this is for that it is not for them.
    expect(container.textContent ?? "").not.toMatch(/\b(she|her|hers)\b/i);
  });

  it("sends the visitor to the sign-in route without carrying a form itself", () => {
    const { container } = render(<Marketing />);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /get started/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/signin");
  });

  it("labels no control exactly 'Sign in'", () => {
    render(<Marketing />);
    // e2e/helpers.ts drives the OTP flow with `{ name: "Sign in", exact: true }`. A second
    // exact match anywhere in the signed-out tree makes that selector ambiguous and breaks
    // every spec that signs in.
    // A string `name` is a full-string match in testing-library, so this is the exact check.
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });
});

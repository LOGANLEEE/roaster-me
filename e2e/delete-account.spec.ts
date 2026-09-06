import { expect, test } from "@playwright/test";
import {
  UNKNOWN_FLIGHT_NO,
  expectRosterCount,
  openAddForm,
  signInThroughUi,
} from "./helpers";

/**
 * Deleting an account, end to end.
 *
 * Run in its OWN context with a throwaway address, never the suite's shared account: this spec
 * destroys the user it signs in as, and doing that to the shared one would take every other spec
 * with it. `cf-connecting-ip` is set because OTP sends are rate limited to 3/min per IP
 * (worker/src/auth.ts) and this spec spends one of them.
 *
 * The property worth checking in a real browser rather than jsdom is the confirmation itself:
 * it is a native <dialog>, and jsdom implements neither showModal nor Esc.
 */
test("delete account: confirm by typing the address, and the roster goes with it", async ({
  browser,
}) => {
  test.slow(); // a full sign-in, a trip, and a deletion

  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "cf-connecting-ip": "203.0.113.80" },
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 844 });

  const email = `doomed-${Date.now()}@local.test`;
  await signInThroughUi(page, email);
  await expect(page.getByTestId("calendar-grid")).toBeVisible({
    timeout: 20_000,
  });

  // Something to lose, so "the roster is gone" is a real observation rather than a vacuous one.
  const DAY = "2026-11-09";
  await openAddForm(page, DAY);
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByTestId("manual-fallback")).toBeVisible();
  await page.getByTestId("manual-expand").click();
  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill("DXB");
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill("BAH");
  await page.getByLabel(/^dest$/i).blur();
  await page.getByLabel(/departure \(local\)/i).fill(`${DAY}T06:00`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${DAY}T07:10`);
  await page.getByRole("button", { name: /add to roster/i }).click();
  // Server truth first — see expectRosterCount. Asserting the card alone is what blocked the
  // deploy of this very feature twice.
  await expectRosterCount(page, 1);
  await expect(page.getByTestId("delete-trip")).toHaveCount(1);

  // The instrument: prove the API answers for this account BEFORE deleting, or the 401
  // afterwards proves nothing about the deletion.
  expect((await page.request.get("/api/trips")).status()).toBe(200);

  // --- Settings -> danger zone ---
  await page.getByTestId("tab-settings").click();
  await page.getByTestId("delete-account").click();

  const dialog = page.getByTestId("delete-account-dialog");
  await expect(dialog).toBeVisible();
  // A real top-layer modal, not an inline panel — this is what jsdom cannot check.
  expect(await dialog.evaluate((el) => (el as HTMLDialogElement).open)).toBe(
    true,
  );

  // Esc backs out, and nothing happens.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect((await page.request.get("/api/trips")).status()).toBe(200);

  // --- Reopen and confirm properly ---
  await page.getByTestId("delete-account").click();
  const confirm = page.getByTestId("confirm-delete-account");
  await expect(confirm).toBeDisabled();

  await page
    .getByTestId("delete-account-confirm-input")
    .fill("not-my-address@local.test");
  await expect(confirm).toBeDisabled();

  await page.getByTestId("delete-account-confirm-input").fill(email);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Back to the signed-out screen, which since 2026-09-04 is the marketing page at `/` rather
  // than a form — deleting an account should not immediately present a way to make a new one.
  await expect(page.getByTestId("marketing")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel(/email/i)).toHaveCount(0);

  // The account is gone, not just logged out: the cookie no longer opens anything.
  expect((await page.request.get("/api/trips")).status()).toBe(401);
  expect((await page.request.get("/api/me")).status()).toBe(401);

  await ctx.close();
});

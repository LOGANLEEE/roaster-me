import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { EK412, openAddForm, pickCalendarDay, signInThroughUi } from "./helpers";

/**
 * Crew sharing, end to end, with two real accounts in two real browser contexts: A invites,
 * B accepts, B reads A's roster through the badge row and cannot change any of it.
 *
 * Both contexts are built here rather than using the suite's shared storageState, because this
 * needs two DIFFERENT signed-in users at once. Each carries its own `cf-connecting-ip`: OTP
 * sends are rate limited to 3 per minute per IP (worker/src/auth.ts), and without this the two
 * sign-ins here would eat the budget the rest of the suite is already spending. Nothing is
 * weakened by doing it — in production Cloudflare sets that header at the edge and discards
 * whatever the client sent.
 */
async function signIn(browser: Browser, ip: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "cf-connecting-ip": ip },
  });
  const page = await context.newPage();
  const email = `crew-${ip.replace(/\./g, "-")}-${Date.now()}@local.test`;
  await signInThroughUi(page, email);
  await expect(page.getByTestId("calendar-grid")).toBeVisible({ timeout: 20_000 });
  return { page, email };
}

test("crew: invite, accept, read each other's roster, and stop sharing", async ({ browser }) => {
  // The heaviest test in the suite: TWO full email-OTP sign-ins (each allowed 20s on its own)
  // plus a calendar walk to a fixture date months out, all inside the config's 30s default. That
  // leaves no headroom on a loaded CI runner, and it timed out at helpers.ts:91 waiting for the
  // add form — before any of the crew logic under test had run. Not flakiness: a budget smaller
  // than the work. test.slow() triples it.
  test.slow();

  const a = await signIn(browser, "203.0.113.10");
  const b = await signIn(browser, "203.0.113.11");

  // --- A puts a trip on their roster.
  // The fixture date is months out, so this walks the calendar forward to reach it.
  await openAddForm(a.page, EK412.pickedDate);
  await a.page.getByTestId("flightno-input").fill(EK412.flightNo.replace(/^EK/, ""));
  await expect(a.page.getByTestId("autofill-card")).toBeVisible({ timeout: 20_000 });
  await a.page.getByTestId("day-detail-card").getByRole("button", { name: /add to roster/i }).click();
  await expect(a.page.getByTestId("delete-trip")).toBeVisible({ timeout: 20_000 });

  // --- A invites B.
  await a.page.getByTestId("tab-share").click();
  await a.page.getByTestId("crew-invite-email").fill(b.email);
  await a.page.getByTestId("crew-invite-send").click();
  await expect(a.page.getByText(new RegExp(`invited ${b.email}`, "i"))).toBeVisible();

  // Nothing is shared until it's accepted: no badge row for either side yet.
  await a.page.getByTestId("tab-calendar").click();
  await expect(a.page.getByTestId("crew-badges")).toHaveCount(0);

  // --- B accepts.
  await b.page.getByTestId("tab-share").click();
  await b.page.getByTestId("crew-panel").getByRole("button", { name: /^accept$/i }).click();
  await expect(b.page.getByRole("button", { name: /stop sharing/i })).toBeVisible();

  // --- B reads A's roster.
  await b.page.getByTestId("tab-calendar").click();
  await b.page.reload();
  const badge = b.page.getByTestId("crew-badges").getByRole("button", { name: new RegExp(a.email.split("@")[0]!, "i") });
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await badge.click();

  await pickCalendarDay(b.page, EK412.pickedDate);
  const card = b.page.getByTestId("day-detail-card");
  await expect(card).toContainText(EK412.origin);

  // The whole point of sharing: the person who is NOT crew can see the clock. Asserting the
  // route alone would pass on a card that shows dates and cities and no times at all — which is
  // exactly what the deleted share link did.
  //
  // Report time WAS asserted here and is not any more: it came off the card on 2026-08-31,
  // because the crew member reads it in her airline's own app. Note that the person on the
  // other side of this share does NOT have that app — if the shared view should keep report,
  // this is the assertion to put back, and the card needs a read-only branch to match.
  await expect(card).toContainText(EK412.depTime);
  await expect(card).toContainText(EK412.arrTime);
  await expect(card).not.toContainText(/report/i);

  // Read-only: no edit, no delete, and no add form on one of their empty days.
  await expect(b.page.getByTestId("day-detail-action")).toHaveCount(0);
  await expect(b.page.getByTestId("delete-trip")).toHaveCount(0);
  await pickCalendarDay(b.page, EK412.nextFreeDate);
  await expect(b.page.getByTestId("day-detail-card")).toContainText(/no duty/i);
  await expect(b.page.getByTestId("flightno-input")).toHaveCount(0);

  // Their own roster is still their own, and still editable.
  await b.page.getByTestId("crew-badge-self").click();
  await expect(b.page.getByTestId("crew-badge-self")).toHaveAttribute("aria-pressed", "true");
  await openAddForm(b.page, EK412.nextFreeDate);

  // --- A stops sharing; B loses the badge and the access.
  await a.page.getByTestId("tab-share").click();
  await a.page.getByRole("button", { name: /stop sharing/i }).click();
  await expect(a.page.getByRole("button", { name: /stop sharing/i })).toHaveCount(0);

  await b.page.reload();
  await expect(b.page.getByTestId("calendar-grid")).toBeVisible({ timeout: 20_000 });
  await expect(b.page.getByTestId("crew-badges")).toHaveCount(0);

  // --- A's own trip survived all of it, untouched.
  await a.page.getByTestId("tab-calendar").click();
  await pickCalendarDay(a.page, EK412.pickedDate);
  await expect(a.page.getByTestId("day-detail-card")).toContainText(EK412.origin);

  // Leave the account as it was found: this spec's trip is its own to clean up.
  await a.page.getByTestId("delete-trip").click();
  await a.page.getByTestId("confirm-delete").click();
  await expect(a.page.getByTestId("delete-trip")).toHaveCount(0);

  await a.page.context().close();
  await b.page.context().close();
});

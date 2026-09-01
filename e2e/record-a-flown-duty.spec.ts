import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, expectRosterCount } from "./helpers";

/**
 * A roster is a record as much as a plan. A duty is usually typed up after it is flown, so the
 * day it belongs to is already behind you — and every day in the past used to be inert.
 *
 * That was date-picker convention, not a decision: nothing downstream ever objected. The schedule
 * lookup does not read the direction of the date, `/api/trips` stores any `depUtc`, and both alert
 * scans search forward from now, so a past duty never matches them. What the rule did do was
 * strand a correction — a wrongly-dated pairing, once deleted, could not be entered again.
 *
 * `openAddForm` is not used here on purpose: it is written for a future day, and reaching a past
 * one means paging backwards.
 */
const PAST_DAY = "2026-06-08"; // comfortably behind the suite's clock, and its own month

test("a day already behind you can still be filled in", async ({ page }) => {
  test.slow();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  // Page back until the month holding PAST_DAY is on screen.
  const [, targetMonth] = PAST_DAY.split("-");
  const monthName = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][Number(targetMonth) - 1]!;
  for (let i = 0; i < 24; i++) {
    const label = await page.getByTestId("calendar-month").textContent();
    if (label?.includes(monthName) && label.includes("2026")) break;
    await page.getByTestId("calendar-prev").click();
  }
  await expect(page.getByTestId("calendar-month")).toContainText(monthName);

  // The cell is dimmed — it is still in the past — but it is reachable.
  const cell = page.getByTestId(`calendar-day-${PAST_DAY}`);
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveClass(/opacity-60/);

  await cell.click();

  // Tapping it opens the add form, exactly as a future empty day does.
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByTestId("manual-fallback")).toBeVisible();
  await page.getByTestId("manual-expand").click();
  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill("DXB");
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill("BKK");
  await page.getByLabel(/^dest$/i).blur();
  await page.getByLabel(/departure \(local\)/i).fill(`${PAST_DAY}T09:00`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${PAST_DAY}T15:30`);
  await page.getByRole("button", { name: /add to roster/i }).click();

  await expectRosterCount(page, 1);

  // And it lands on the day it was flown, marked like any other duty.
  await expect(page.getByTestId(`calendar-day-${PAST_DAY}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`day-mark-${PAST_DAY}`)).toContainText("BKK");

  await clearRoster(page);
});

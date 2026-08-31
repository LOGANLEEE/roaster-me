import { expect, test } from "@playwright/test";
import { clearRoster, expectRosterCount, openAddForm, pickCalendarDay } from "./helpers";

/**
 * A multi-sector flight number is one aircraft routing, and the crew can join partway along it.
 * EK248 is EZE→GIG→DXB; Isis worked it from Rio. Her roster said "26 Aug", meaning the RIO
 * departure — but the picked date was read as leg 0's date at Buenos Aires, which pushed Rio to
 * the 27th and Dubai to the 28th. She was home at 00:50 on the 27th, and the calendar said
 * Thursday.
 *
 * Choosing where she gets on re-dates the whole routing around that sector. This measures the
 * result in a real browser: which day the calendar marks, what the card's dates say, and that
 * the sector she never sat on is kept as the aircraft's routing rather than as her duty.
 *
 * EK9996 (scripts/seed-e2e-fixtures.sql) is EK248's shape with seeded airports. February 2027 is
 * clear of every other spec's range.
 */
const FLIGHT = "EK9996";
const BOARD_DAY = "2027-02-10"; // the GRU departure — the date her roster would carry
const PRIOR_DAY = "2027-02-09"; // the EZE sector the aircraft flew to reach her
const LANDING_DAY = "2027-02-11"; // Dubai, 00:30 local — the morning she walks in

test("boarding partway: the picked date is the sector she flies, not the one the aircraft started on", async ({
  page,
}) => {
  test.slow();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  await openAddForm(page, BOARD_DAY);
  await page.getByTestId("flightno-input").fill(FLIGHT.slice(2));
  await expect(page.getByTestId("autofill-card")).toBeVisible();

  // Both boarding points offered. Leg 0 is the default, so nothing is claimed about the date.
  await expect(page.getByTestId("boarding-point")).toBeVisible();
  await expect(page.getByTestId("boarding-note")).toHaveCount(0);

  await page.getByTestId("boarding-GRU").click();
  await expect(page.getByTestId("boarding-note")).toContainText("GRU departure");

  await page.getByRole("button", { name: /add to roster/i }).click();
  await expectRosterCount(page, 1);

  // --- The calendar ---
  // The duty is the 10th, in home-base local time; the 11th is the morning she lands at 00:30.
  // The 9th belongs to the aircraft, not to her, and stays clean.
  await expect(page.getByTestId(`calendar-day-${BOARD_DAY}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`day-mark-${BOARD_DAY}`)).toContainText("↙");
  await expect(page.getByTestId(`day-mark-${BOARD_DAY}`)).toContainText("GRU");
  await expect(page.getByTestId(`calendar-day-${LANDING_DAY}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`day-mark-${LANDING_DAY}`)).toContainText("DXB");
  await expect(page.getByTestId(`calendar-day-${PRIOR_DAY}`)).not.toHaveClass(/bg-accent-soft/);

  // --- The card ---
  await pickCalendarDay(page, BOARD_DAY);
  const card = page.getByTestId("day-detail-card");
  await expect(card).toContainText("10 Feb");
  await expect(card).toContainText("00:30");
  // The landing date rides the Lands row since the DEP/ARR board was deleted on 2026-08-31.
  await expect(card).toContainText(/Lands · \w{3} 11/);
  // The route headline is her duty alone.
  await expect(card).toContainText("GRU → DXB");

  // The EZE sector is kept so the routing reads true, and it is filed under a heading that says
  // which side of her duty it sits on — "continues without you" would be the wrong way round.
  await page.getByRole("button", { name: /edit trip/i }).click();
  const prior = page.getByTestId("trip-prior-routing");
  await expect(prior).toContainText("EZE");
  await expect(prior).toContainText(/arrives before you board/i);
  await expect(page.getByTestId("trip-continuation")).toHaveCount(0);

  // Nothing about the extra panel may push the page sideways at 390px.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  await clearRoster(page);
});

import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, expectRosterCount, openAddForm, pickCalendarDay } from "./helpers";

/**
 * The flight home routinely lands after midnight at base. EK248 left Rio on the 27th and its
 * wheels touched Dubai at 00:09 on the 28th — so the roster marked the 28th as another day away
 * and labelled it "layover · DXB", a day down-route at her own home airport. The person waiting
 * read that as "she got back on Thursday" when she walked in on Friday morning.
 *
 * The duty stays on the day it is flown, and the morning after carries an ARRIVAL mark rather
 * than another day down-route. The card spells out the landing date too, instead of leaving a
 * "+2" to add to a departure date in Argentina.
 *
 * Dates are in January 2027, clear of every other spec's range, so a shared account cannot make
 * one spec's leftovers look like another's run.
 */
const OUT_DAY = "2027-01-11";
const LAYOVER_DAYS = ["2027-01-12", "2027-01-13", "2027-01-14"];
const RETURN_DAY = "2027-01-15";
const LANDING_DAY = "2027-01-16";

async function addSector(
  page: import("@playwright/test").Page,
  origin: string,
  dest: string,
  depLocal: string,
  arrLocal: string,
  expectedTotal: number,
): Promise<void> {
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByTestId("manual-fallback")).toBeVisible();
  await page.getByTestId("manual-expand").click();
  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill(origin);
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill(dest);
  await page.getByLabel(/^dest$/i).blur();
  await page.getByLabel(/departure \(local\)/i).fill(depLocal);
  await page.getByLabel(/arrival \(local\)/i).fill(arrLocal);
  await page.getByRole("button", { name: /add to roster/i }).click();
  await expectRosterCount(page, expectedTotal);
}

test("a red-eye home ends the away run on the day it is flown, not on the morning it lands", async ({
  page,
}) => {
  test.slow(); // two manual entries plus a month of measurements

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  // Out to Buenos Aires on the 11th.
  await openAddForm(page, OUT_DAY);
  await addSector(page, "DXB", "EZE", `${OUT_DAY}T03:00`, `${OUT_DAY}T14:00`, 1);

  // Home on the 15th: airborne from EZE at 02:00 local, on stand in Dubai at 00:30 the NEXT
  // local day. Dubai is seven hours ahead of Buenos Aires, so the landing falls past midnight.
  await openAddForm(page, RETURN_DAY);
  await addSector(page, "EZE", "DXB", `${RETURN_DAY}T02:00`, `${LANDING_DAY}T00:30`, 2);

  const cell = (iso: string) => page.getByTestId(`calendar-day-${iso}`);

  // The layover days between the two trips still read as away — that behaviour is untouched.
  for (const iso of LAYOVER_DAYS) {
    await expect(cell(iso)).toHaveClass(/bg-accent-soft/);
  }

  // The 15th is the day she comes home, and it says so.
  await expect(cell(RETURN_DAY)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`day-mark-${RETURN_DAY}`)).toContainText("EZE");
  await expect(page.getByTestId(`day-mark-${RETURN_DAY}`)).toContainText("↙");

  // The 16th is the morning she lands, at 00:30. It belongs to the trip and it says so — but as
  // an ARRIVAL, not as another day down-route. "layover · DXB" was the original bug; dropping
  // the day entirely was the overcorrection that left the calendar silent about the one morning
  // the person waiting is looking for.
  await expect(cell(LANDING_DAY)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`day-mark-${LANDING_DAY}`)).toContainText("↙");
  await expect(page.getByTestId(`day-mark-${LANDING_DAY}`)).toContainText("DXB");
  // And no further: the 17th is hers.
  await expect(page.getByTestId("calendar-day-2027-01-17")).not.toHaveClass(/bg-accent-soft/);

  // The card carries the landing DATE, not a day offset to add to a date in another country.
  await pickCalendarDay(page, RETURN_DAY);
  const card = page.getByTestId("day-detail-card");
  await expect(card).toContainText("15 Jan");
  await expect(card).toContainText("00:30");
  // The date rides the Lands row now — the DEP/ARR board that used to carry it went on
  // 2026-08-31, because every other row on it was the timeline's own words repeated.
  await expect(card).toContainText(/Lands · \w{3} 16/);

  // Nothing about the longer Lands row may push the page sideways at 390px.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // And the ARR value itself stays inside the card it lives in, rather than clipping at the
  // right edge — the failure a screenshot would show as "looks fine".
  const fits = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='day-detail-card']") as HTMLElement | null;
    if (!el) return null;
    return el.scrollWidth <= el.clientWidth;
  });
  expect(fits).toBe(true);

  await clearRoster(page);
});

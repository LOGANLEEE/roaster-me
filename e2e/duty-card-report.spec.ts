import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, expectRosterCount, openAddForm, pickCalendarDay } from "./helpers";

/**
 * The duty card after the 2026-08-31 cleanup, measured in a real engine because all three of
 * these are things a unit test cannot see.
 *
 * 1. Report is printed ONCE. It headed the board AND was the timeline's second row, the same
 *    time twice on one card. The board is DEP/ARR now and the timeline keeps report, amber.
 * 2. "Leave home" is gone. It was report minus a flat 55 minutes — no home, no distance, no
 *    traffic in that number.
 * 3. The layover panel stays up for the whole duty the layover feeds, including the morning a
 *    red-eye lands at base. The window used to end at the outbound's DEPARTURE, so of the two
 *    days that render the very same trip card, one carried the panel and one did not.
 *
 * And the entrance animation: a CSS entry animation fires once per element, and the same trip
 * renders on every day it spans, so tapping the second day used to animate nothing. Proven by
 * counting real `animationstart` events, not by looking at a screenshot.
 *
 * September 2027, clear of every other spec's dates.
 */
const OUT_DAY = "2027-09-10";
const RETURN_DAY = "2027-09-14";
const LANDING_DAY = "2027-09-15";

async function addSector(
  page: import("@playwright/test").Page,
  origin: string,
  dest: string,
  depLocal: string,
  arrLocal: string,
  expectedTotal: number,
): Promise<void> {
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByText(/unknown flight/i)).toBeVisible();
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

test("report is printed once, leave-home is gone, and the layover panel covers the landing day", async ({
  page,
}) => {
  test.slow(); // two manual entries plus computed-style and animation measurements

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  await openAddForm(page, OUT_DAY);
  await addSector(page, "DXB", "EZE", `${OUT_DAY}T03:00`, `${OUT_DAY}T14:00`, 1);

  // Home on the 14th: airborne from Buenos Aires at 02:00 local, on stand in Dubai at 00:30 the
  // next local day. That split is the whole point — the two days render the same trip card.
  await openAddForm(page, RETURN_DAY);
  await addSector(page, "EZE", "DXB", `${RETURN_DAY}T02:00`, `${LANDING_DAY}T00:30`, 2);

  await pickCalendarDay(page, RETURN_DAY);
  const card = page.getByTestId("day-detail-card");
  await expect(card).toBeVisible();

  // --- 1. The board is DEP/ARR, and report appears exactly once on the whole card. ---
  await expect(card).toContainText(/dep/i);
  await expect(card).toContainText(/arr/i);
  // Counted over the board and the timeline only. The layover panel below them says "free until
  // report" too, and that is a different sentence about a different thing — the duplication this
  // removes was the same TIME printed twice, four lines apart.
  expect(
    await card.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector('[data-testid="layover-brief"]')?.remove();
      return (copy.textContent?.match(/report/gi) ?? []).length;
    }),
  ).toBe(1);

  // ...and it is still the loudest thing on the card. Measured against the row below it rather
  // than against a hex string: what matters is that report does not read like an ordinary row.
  const timeline = page.getByTestId("duty-timeline");
  const [reportColour, departsColour] = await timeline.evaluate((el) => {
    const label = (text: string) =>
      [...el.querySelectorAll("p")].find((p) => p.textContent?.trim() === text)!;
    return [
      getComputedStyle(label("Report")).color,
      getComputedStyle(label("Departs")).color,
    ];
  });
  expect(reportColour).not.toBe(departsColour);

  // --- 2. Leave home is gone, and so is the row it drew. ---
  await expect(card).not.toContainText(/leave home/i);

  // --- 3. The layover panel is on the day she flies home AND on the morning she lands. ---
  // Both days render the same trip card; the panel used to stop at the departure date, so the
  // two cards differed with nothing on screen saying why.
  await expect(page.getByTestId("layover-brief")).toBeVisible();
  await expect(page.getByTestId("layover-brief")).toContainText(/EZE|Buenos Aires/);

  // --- 4. The stagger plays again on the second day of the same duty. ---
  // Counted from real animationstart events. Before the fix this stayed at 0: React kept the
  // same rows, and a CSS entry animation cannot fire twice on one element.
  //
  // Wait for THIS day's stagger to finish first. Rows enter at 70ms * index, and animationstart
  // fires after that delay — a listener installed while the first timeline was still settling
  // caught its trailing rows and counted them as the second day's, which made this assertion
  // pass with the fix reverted.
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tl-enter")].every((row) =>
      row.getAnimations().every((animation) => animation.playState === "finished"),
    ),
  );

  await page.evaluate(() => {
    (window as unknown as { __tlStarts: number }).__tlStarts = 0;
    document.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target as HTMLElement;
        if (target.classList?.contains("tl-enter")) {
          (window as unknown as { __tlStarts: number }).__tlStarts += 1;
        }
      },
      true,
    );
  });

  await pickCalendarDay(page, LANDING_DAY);
  await expect(page.getByTestId("duty-timeline")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __tlStarts: number }).__tlStarts))
    .toBeGreaterThan(0);

  // Same duty on this day, so the same panel — that is the point of the window change.
  await expect(page.getByTestId("layover-brief")).toBeVisible();
  await expect(page.getByTestId("day-detail-card")).not.toContainText(/leave home/i);
});

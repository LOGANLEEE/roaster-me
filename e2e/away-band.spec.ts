import { expect, test } from "@playwright/test";
import {
  UNKNOWN_FLIGHT_NO,
  clearRoster,
  openAddForm,
  pickCalendarDay,
  expectRosterCount,
} from "./helpers";

/**
 * A pairing is usually two trips — out on one, back days later — and the layover days between
 * belong to neither. They used to render exactly like a day at home, which is the wrong answer
 * for the person waiting at home: she is not flying, but she is also not coming back.
 *
 * Those days are now marked, and a run of days away is drawn as ONE band rather than as
 * neighbouring boxes that happen to share a colour. Both properties are geometry, so both are
 * measured here rather than eyeballed — a screenshot is how the calendar-width bug came back
 * three times.
 */

// Clear of every other spec's dates, so a shared account cannot make leftovers look like a run.
const OUT_DAY = "2026-12-14"; // Monday — the run starts at the left edge of a week
const BACK_DAY = "2026-12-17";
const LAYOVER_DAYS = ["2026-12-15", "2026-12-16"];
const HOME_DAY = "2026-12-21";

async function addSector(
  page: import("@playwright/test").Page,
  iso: string,
  origin: string,
  dest: string,
  depTime: string,
  arrTime: string,
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
  await page.getByLabel(/departure \(local\)/i).fill(`${iso}T${depTime}`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${iso}T${arrTime}`);
  await page.getByRole("button", { name: /add to roster/i }).click();

  await expectRosterCount(page, expectedTotal);
}

test("away days: the layover between two trips is marked, and the run reads as one band", async ({
  page,
}) => {
  test.slow(); // two manual entries plus a month of measurements

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  // --- Today is marked on the NUMBER, in a colour that is not the accent. ---
  // Measured HERE, before the calendar is paged to December: today is in the current month, so
  // after navigating there is no aria-current cell to find and the check would pass on nothing.
  // The old treatment rang the cell in the accent, one pixel from the selected ring, so the two
  // were indistinguishable. Different surface, and a different colour.
  const todayMark = await page.evaluate(() => {
    const el = document.querySelector(
      "[aria-current='date']",
    ) as HTMLElement | null;
    if (!el) return null;
    const num = el.querySelector("span.num") as HTMLElement | null;
    if (!num) return null;
    // Resolve the accent through the cascade so both values are comparable rgb() strings.
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--color-accent)";
    el.appendChild(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cs = getComputedStyle(num);
    return { background: cs.backgroundColor, radius: cs.borderRadius, accent };
  });
  expect(todayMark).not.toBeNull();
  expect(todayMark!.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(todayMark!.radius).not.toBe("0px");
  // The whole point of the change: today stops borrowing the colour that means "duty".
  expect(todayMark!.background).not.toBe(todayMark!.accent);

  // Out of base on the 14th, back to base on the 17th. Two separate trips, one pairing.
  await openAddForm(page, OUT_DAY);
  await addSector(page, OUT_DAY, "DXB", "EZE", "03:00", "22:00", 1);
  await expect(page.getByTestId("delete-trip")).toHaveCount(1);

  await openAddForm(page, BACK_DAY);
  await addSector(page, BACK_DAY, "EZE", "DXB", "02:00", "20:00", 2);
  await expect(page.getByTestId("delete-trip")).toHaveCount(1);

  const cell = (iso: string) => page.getByTestId(`calendar-day-${iso}`);

  // --- The days in between are no longer blank. ---
  for (const iso of LAYOVER_DAYS) {
    await expect(cell(iso)).toHaveClass(/bg-accent-soft/);
    // And they say where she is, not just that she is somewhere.
    await expect(page.getByTestId(`day-mark-${iso}`)).toContainText("EZE");
  }
  // A day she really is at home stays unmarked — the change must not paint everything.
  await expect(cell(HOME_DAY)).not.toHaveClass(/bg-accent-soft/);

  // --- The run is one object, measured: no seam between consecutive away days. ---
  // Cells are 0.5rem apart. Between two days inside the band that gap must be filled, so the
  // painted background is continuous from one cell's right edge to the next cell's left edge.
  const seam = await page.evaluate(
    ([aSel, bSel]) => {
      const a = document.querySelector(aSel) as HTMLElement | null;
      const b = document.querySelector(bSel) as HTMLElement | null;
      if (!a || !b) return null;
      const bridge = a.querySelector(
        "span[aria-hidden='true']",
      ) as HTMLElement | null;
      if (!bridge) return { bridged: false, gap: 0, covered: 0 };
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const gr = bridge.getBoundingClientRect();
      // Coverage, not equality: what matters is that no pixel between the two cells is left
      // unpainted, on any edge. Overlap onto either neighbour is the same colour and invisible.
      return {
        bridged: true,
        gap: Math.round(br.left - ar.right),
        uncoveredLeft: Math.round(gr.left - ar.right),
        uncoveredRight: Math.round(br.left - gr.right),
        uncoveredTop: Math.round(gr.top - ar.top),
        uncoveredBottom: Math.round(ar.bottom - gr.bottom),
        background: getComputedStyle(bridge).backgroundColor,
        cellBackground: getComputedStyle(a).backgroundColor,
      };
    },
    [
      `[data-testid="calendar-day-${LAYOVER_DAYS[0]}"]`,
      `[data-testid="calendar-day-${LAYOVER_DAYS[1]}"]`,
    ],
  );

  expect(seam).not.toBeNull();
  expect(seam!.bridged).toBe(true);
  expect(seam!.gap).toBeGreaterThan(0); // proves there is a gap to bridge at all
  expect(seam!.uncoveredLeft).toBeLessThanOrEqual(0);
  expect(seam!.uncoveredRight).toBeLessThanOrEqual(0);
  expect(seam!.uncoveredTop).toBeLessThanOrEqual(0);
  expect(seam!.uncoveredBottom).toBeLessThanOrEqual(0);
  // Painted, not merely present: a transparent bridge passes every geometry check above.
  expect(seam!.background).toBe(seam!.cellBackground);

  // --- The invariant that keeps regressing: nothing scrolls sideways at 390px. ---
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // The bridge sits outside its button's box, so prove it did not steal the next day's taps.
  await pickCalendarDay(page, LAYOVER_DAYS[1]!);
  await expect(
    page.getByTestId(`calendar-day-${LAYOVER_DAYS[1]}`),
  ).toHaveAttribute("aria-pressed", "true");

  await clearRoster(page);
});

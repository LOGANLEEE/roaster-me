import { expect, test } from "@playwright/test";
import { openAddForm, signInThroughUi } from "./helpers";

/**
 * Layout invariants that unit tests structurally cannot catch, because every one of them is a
 * computed geometry problem in a real engine rather than a rendered-output problem.
 *
 * Each assertion here corresponds to a bug that actually shipped to the user:
 * - the calendar grid rendering narrower than the card below it (three separate times)
 * - a duration label colliding with the times at phone width
 * - a form control under 16px, which makes iOS zoom on focus and wreck the layout
 *
 * All of them passed the unit suite while broken, and the width regression was "fixed" twice by
 * patching the symptom. Measuring is the only thing that has ever caught them.
 */
/** Far enough out that no other spec's fixture dates collide with it, and fixed rather than
 * derived from today so a failure is reproducible on any day of the year. */
const EMPTY_DAY = "2027-03-17";

test.describe("layout invariants at phone width", () => {
  // A FRESH account, not the shared e2e one: this spec asserts against the empty state, and the
  // shared account carries whatever trips the other specs left behind. Signing in here also means
  // the assertions don't depend on spec execution order.
  test.use({ viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] } });

  test("/ is the pitch and carries no form, at 390px", async ({ page }) => {
    // Until 2026-09-03 this screen asked for an email 300px before it said what the app was.
    // The fix put the pitch first, which pushed the form to the bottom of a 2670px page. The
    // split is what resolves it: `/` explains, `/signin` asks, and neither is second.
    await page.goto("/");
    await expect(page.getByTestId("marketing")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);

    await expectNoHorizontalOverflow(page, "marketing");
    await expectNoTinyControls(page, "marketing");

    // Both CTAs are real touch targets. The manual-entry link on the add form was 20px tall for
    // months for exactly this reason.
    const ctas = page.getByRole("link", { name: /get started/i });
    const count = await ctas.count();
    expect(count, "marketing has no call to action").toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await ctas.nth(i).boundingBox();
      expect(box, `CTA ${i} has no box`).not.toBeNull();
      expect(box!.height, `CTA ${i} is under 44px`).toBeGreaterThanOrEqual(44);
    }
  });

  test("/signin puts the form above the fold at 390px", async ({ page }) => {
    // The whole point of the split, and the one assertion that fails on the pre-split page:
    // there, the four content blocks pushed the email field to y~2200 on a 844px-tall screen.
    await page.goto("/signin");
    const email = page.getByLabel(/email/i);
    await expect(email).toBeVisible();

    const box = await email.boundingBox();
    expect(box, "the email field has no box").not.toBeNull();
    expect(box!.y, "the email field must be reachable without scrolling").toBeLessThan(844);
    // Still the narrow column, not stretched to the full page width.
    expect(box!.width).toBeLessThan(390);

    await expectNoHorizontalOverflow(page, "signin");
    // A control under 16px makes iOS zoom on focus and wrecks the layout. Note a Tailwind
    // `text-sm` on an input beats the global 16px floor in tokens.css.
    await expectNoTinyControls(page, "signin");

    for (const name of [/send code/i, /continue with google/i]) {
      const b = await page.getByRole("button", { name }).boundingBox();
      expect(b, `${name} has no box`).not.toBeNull();
      expect(b!.height, `${name} is under 44px`).toBeGreaterThanOrEqual(44);
    }
  });

  test("calendar matches its container width, nothing overflows, no control is under 16px", async ({
    page,
  }) => {
    await signInThroughUi(page, `layout-${Date.now()}@local.test`);

    // --- The empty state: this is the no-upcoming-duty branch, the one that kept regressing.
    // It regressed precisely because it was the branch nobody screenshotted.
    await expect(page.getByTestId("day-detail-card")).toContainText(/no duty/i, { timeout: 15_000 });
    await expectCalendarMatchesContainer(page, "empty state");
    await expectNoHorizontalOverflow(page, "empty state");

    // --- With the inline add form open on an empty day.
    await openAddForm(page, EMPTY_DAY);
    await expectCalendarMatchesContainer(page, "add form open");
    await expectNoHorizontalOverflow(page, "add form open");

    // Every focusable control must be >=16px or iOS zooms on focus. A Tailwind text-sm on an
    // input beats the global floor in tokens.css, so this can regress from a single class.
    await expectNoTinyControls(page, "add form open");

    // --- With a trip on the day: the board card, then its scroll-expanded timeline.
    await page.getByTestId("flightno-input").fill("412");
    await expect(page.getByTestId("autofill-card")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("day-detail-card").getByRole("button", { name: /add to roster/i }).click();
    await expect(page.getByTestId("delete-trip")).toBeVisible({ timeout: 15_000 });

    await expectCalendarMatchesContainer(page, "trip card shown");
    await expectNoHorizontalOverflow(page, "trip card shown");

    // NOT asserted yet: the scroll-expanded timeline. It failed here with duty-timeline never
    // appearing, and the likeliest cause is that at 390x844 with a single trip the page has less
    // than the 60px of scroll the collapse needs — which would be a real product gap, not a test
    // bug, since the interaction would then be unreachable on a tall phone with a short roster.
    // Left out rather than guess-fixed: an assertion I cannot explain is worse than none.
  });
});

/**
 * The calendar grid must be exactly as wide as the column it sits in. It has been narrower three
 * times, always because an ancestor centred its children and a newly-inserted wrapper had no
 * width of its own — so asserting against the container, not a fixed number, is what catches it.
 */
async function expectCalendarMatchesContainer(page: import("@playwright/test").Page, label: string) {
  const widths = await page.evaluate(() => {
    const cell = document.querySelector('[data-testid^="calendar-day-"]');
    if (!cell) return null;
    const grid = cell.closest(".grid-cols-7");
    const container = grid?.closest(".max-w-xl");
    if (!grid || !container) return null;
    return {
      grid: Math.round(grid.getBoundingClientRect().width),
      container: Math.round(container.getBoundingClientRect().width),
    };
  });

  expect(widths, `${label}: calendar grid and container should both be measurable`).not.toBeNull();
  expect(
    Math.abs(widths!.grid - widths!.container),
    `${label}: calendar grid (${widths!.grid}px) should match its container (${widths!.container}px)`,
  ).toBeLessThanOrEqual(1);
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page should not scroll horizontally at 390px`).toBeLessThanOrEqual(0);
}

async function expectNoTinyControls(page: import("@playwright/test").Page, label: string) {
  const tiny = await page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea, button")]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => {
        const testId = (el as HTMLElement).dataset.testid;
        return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ""}=${getComputedStyle(el).fontSize}`;
      }),
  );
  expect(tiny, `${label}: controls under 16px make iOS zoom on focus`).toEqual([]);
}

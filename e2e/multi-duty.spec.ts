import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, openAddForm, rosterTrips } from "./helpers";

/**
 * A calendar date can hold more than one duty. A turnaround in the morning and a standby that
 * evening are two separate trips with their own report times — not legs of one — so the day card
 * stacks a card per duty, each with its own edit and delete.
 *
 * Before this, `tripForDay` returned the FIRST trip covering a date and stopped, so a second
 * duty on that day was invisible; and the tab bar's + button walked forward to the next
 * trip-free day, so you could not even navigate to a day to add a second one.
 *
 * Also covers the delete confirmation, which is a native <dialog> — jsdom implements neither
 * showModal nor Esc, so the modal behaviour is only ever real here, never in the unit suite.
 */

// Deliberately clear of the dates autofill.spec and roster.spec use, so a shared account cannot
// make one spec's leftovers look like this one's second duty.
const DAY = "2026-12-04";

async function addManualDuty(
  page: import("@playwright/test").Page,
  iso: string,
  dest: string,
  depTime: string,
  arrTime: string,
): Promise<void> {
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByTestId("manual-fallback")).toBeVisible();
  await page.getByTestId("manual-expand").click();
  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill("DXB");
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill(dest);
  await page.getByLabel(/^dest$/i).blur();
  await page.getByLabel(/departure \(local\)/i).fill(`${iso}T${depTime}`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${iso}T${arrTime}`);
  await page.getByRole("button", { name: /add to roster/i }).click();
}

test("two duties on one day: stacked cards, modal confirm, delete one and the other survives", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  // --- First duty: an early turnaround. ---
  await openAddForm(page, DAY);
  await addManualDuty(page, DAY, "BAH", "06:00", "07:10");
  await expect(page.getByTestId("delete-trip")).toHaveCount(1);

  // --- Second duty, SAME day. The day is no longer empty, so the add form is behind an
  // explicit affordance rather than being the card itself. ---
  const addAnother = page.getByTestId("add-another-duty");
  await expect(addAnother).toBeVisible();
  await addAnother.click();
  await addManualDuty(page, DAY, "LHR", "18:00", "22:30");

  // --- Both duties are on screen, each with its own controls. ---
  await expect(page.getByTestId("day-detail-card")).toHaveCount(2);
  await expect(page.getByTestId("delete-trip")).toHaveCount(2);
  expect(await rosterTrips(page)).toHaveLength(2);

  // Nothing may scroll sideways at phone width with two cards stacked.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // --- The trash opens a real modal, and Esc cancels without deleting. ---
  await page.getByTestId("delete-trip").first().click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog).toBeVisible();
  // Native modal semantics: the element is a top-layer dialog, not an inline panel.
  expect(await dialog.evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await rosterTrips(page)).toHaveLength(2);

  // --- Confirming deletes exactly one duty; the other stays. ---
  await page.getByTestId("delete-trip").first().click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete").click();

  await expect(page.getByTestId("delete-trip")).toHaveCount(1);
  const left = await rosterTrips(page);
  expect(left).toHaveLength(1);
  // The survivor is the evening duty — the morning one was first in the stack and was deleted.
  expect(left[0]!.flights[0]!.dest).toBe("LHR");

  await clearRoster(page);
});

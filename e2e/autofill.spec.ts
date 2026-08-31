import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, openAddForm, rosterTrips } from "./helpers";

/**
 * Manual-fallback + multi-leg coverage for the inline add-trip form, complementing
 * roster.spec.ts's primary EK412-autofill + sequential-add + edit/delete flow:
 *   1. Unknown flight (EK999, no flight_schedules row) - lookup miss falls through to the
 *      full manual-entry path. The form clears and the day flips to the trip view on save, so
 *      a second manual add happens via a fresh empty-day form on the next day.
 *   2. EK384 (DXB -> BKK -> HKG, two legs) - a cheap smoke test that the autofill card
 *      renders both legs of a multi-leg schedule lookup.
 *
 * Starts already signed in via the shared storageState (auth.setup.ts, one OTP for the
 * whole suite) - see playwright.config.ts's `chromium` project. This file no longer sends
 * an OTP of its own; TURNAROUND's EK9997/EK9998 legs are pre-warmed cache rows (see
 * scripts/seed-e2e-fixtures.sql) so this scenario never depends on a live provider fetch.
 */

/** DXB -> BKK -> HKG, EK384 (scripts/ek-schedules.json): 2 legs, both same-day. */
const EK384 = {
  flightNo: "EK384",
  leg0: { origin: "DXB", dest: "BKK" },
  leg1: { origin: "BKK", dest: "HKG" },
};

/** Picked date used across this file's scenarios - future, and distinct from roster.spec.ts's
 * FIXTURE month (2026-09) so the two spec files' trips never land in the same calendar cell. */
const PICKED_DATE = "2026-11-12";

/**
 * DXB -> SYD -> CHC, EK412 (scripts/ek-schedules.json), picked 2026-09-10 - the SAME
 * calendar cell roster.spec.ts's own EK412 fixture uses. Both specs now run under the one
 * shared signed-in account (see auth.setup.ts), so this doesn't collide server-side only
 * because this file runs first (autofill -> roster -> share) and its own `clearRoster` call
 * further down deletes the trip before roster.spec.ts's leading cleanup even starts.
 *
 * Leg0 DXB dep 10:15 Asia/Dubai (no DST) on 2026-09-10 = 2026-09-10T06:15:00.000Z.
 * Leg0 arr SYD 06:00 Australia/Sydney, dayOffset 1 -> local date 2026-09-11 =
 * 2026-09-10T20:00:00.000Z.
 * Leg1 SYD dep 07:45 Australia/Sydney, dayOffset 0 -> same local date 2026-09-11 =
 * 2026-09-10T21:45:00.000Z.
 * Leg1 arr CHC 12:55 Pacific/Auckland, dayOffset 0 -> same local date 2026-09-11 =
 * 2026-09-11T00:55:00.000Z. This is the trip's final-leg arrival.
 *
 * EK413 (CHC -> SYD, dep 14:00 local, daily "1234567") is added as a second, separate flight
 * on its own operating date 2026-09-12 - the app no longer suggests this date for us (the
 * auto return-suggestion chip and its computed layover badge were rapid-entry UI, both
 * removed along with the sheet's post-save "added" state), so it's simply picked by the test,
 * chosen to be a day EK413 actually operates (dep after EK412's own final-leg arrival above).
 */
const EK412_RETURN = {
  outbound: {
    flightNo: "EK412",
    origin: "DXB",
    dest: "SYD",
    depTime: "10:15",
    arrTime: "06:00",
    pickedDate: "2026-09-10",
  },
  ret: {
    flightNo: "EK413",
    dateIso: "2026-09-12",
  },
};

/**
 * DXB -> BCN, EK9997, then BCN -> DXB, EK9998 (scripts/ek-schedules.json): a same-day
 * turnaround (round trip). Picked date 2026-09-15 - free, and outside the EK412_RETURN
 * chain's span (2026-09-10 through 2026-09-12/13) so the two scenarios' calendar marks
 * never overlap.
 *
 * EK9997 leg0: DXB dep 08:20 Asia/Dubai, dayOffset 0 -> arr BCN 12:35 Europe/Madrid, same
 * local date 2026-09-15 (both legs same calendar day at their own tz).
 * EK9998's append anchor date = addDaysIso(EK9997's depDate, EK9997's dayOffset) = 2026-09-15
 * (dayOffset 0) - EK9998 leg0 (BCN->DXB, dep 14:15 local, daily) operates that date.
 * EK9998 arr DXB 00:05 Asia/Dubai, dayOffset 1 -> local date 2026-09-16.
 *
 * One combined trip, 2 legs (leg_seq 0 = EK9997, leg_seq 1 = EK9998). The whole round trip is
 * flown on 2026-09-15 in Asia/Dubai (home base) local dates; the inbound leg's wheels touch at
 * 00:05 the next morning, which the calendar marks as her arrival.
 */
const TURNAROUND = {
  outbound: { flightNo: "EK9997", origin: "DXB", dest: "BCN" },
  appended: { flightNo: "EK9998", origin: "BCN", dest: "DXB" },
  pickedDate: "2026-09-15",
  landingDate: "2026-09-16",
};


test.describe.configure({ mode: "serial" });

test("manual-entry fallback (sequential adds), then EK384 multi-leg smoke", async ({ page }) => {
  // Already signed in via the shared storageState (auth.setup.ts).
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  const autofillCard = page.getByTestId("autofill-card");
  const dayCard = page.getByTestId("day-detail-card");

  // --- Scenario A: two pairings added sequentially. EK412 (DXB->SYD->CHC, lands away from
  // home) is added on its picked date; the form clears and the day flips to the trip view on
  // save (rapid-entry chaining, the "added" state, and the return-suggestion chip are all
  // gone), so EK413 (the flight home) is added separately, on its own known operating date,
  // via a fresh empty-day form - the same lookup flow as any other flight number, just typed
  // rather than suggested. Runs FIRST (Sept dates) — pickCalendarDay/openAddForm (helpers.ts)
  // only navigate the calendar FORWARD via calendar-next, so every scenario in this file must
  // run in chronological date order. ---
  await openAddForm(page, EK412_RETURN.outbound.pickedDate);
  await page.getByTestId("flightno-input").fill(EK412_RETURN.outbound.flightNo.slice(2));
  await expect(autofillCard).toBeVisible();
  await expect(autofillCard).toContainText(`${EK412_RETURN.outbound.origin} → ${EK412_RETURN.outbound.dest}`);
  await expect(page.getByTestId("autofill-dep").first()).toHaveValue(EK412_RETURN.outbound.depTime);
  await expect(page.getByTestId("autofill-arr").first()).toHaveValue(EK412_RETURN.outbound.arrTime);
  await page.getByRole("button", { name: /add to roster/i }).click();

  // Save clears the form immediately - no rapid-entry banner/Done step anymore.
  await expect(page.getByTestId("delete-trip")).toBeVisible();
  await expect(page.getByTestId(`calendar-day-${EK412_RETURN.outbound.pickedDate}`)).toHaveClass(
    /bg-accent-soft/,
  );

  await openAddForm(page, EK412_RETURN.ret.dateIso);
  await page.getByTestId("flightno-input").fill(EK412_RETURN.ret.flightNo.slice(2));
  await expect(autofillCard).toBeVisible();
  await expect(autofillCard).toContainText("CHC → SYD");
  await page.getByRole("button", { name: /add to roster/i }).click();
  await expect(page.getByTestId("delete-trip")).toBeVisible();

  // Both pairings' spans marked on the calendar (EK412 away-span + EK413's own operating date).
  await expect(page.getByTestId(`calendar-day-${EK412_RETURN.outbound.pickedDate}`)).toHaveClass(
    /bg-accent-soft/,
  );
  await expect(page.getByTestId(`calendar-day-${EK412_RETURN.ret.dateIso}`)).toHaveClass(/bg-accent-soft/);

  // Two separate trips, two legs each — the shape a flat row count could never tell apart
  // from one four-leg trip.
  const bothPairings = await rosterTrips(page);
  expect(bothPairings).toHaveLength(2);
  expect(bothPairings.flatMap((t) => t.flights)).toHaveLength(4);
  await clearRoster(page);

  // --- Scenario B: turnaround - "+ add flight" chains EK9998 onto EK9997's preview as ONE
  // combined trip (leg_seq continues), before any save. The appended card renders alongside
  // the outbound card; saving posts a single trip with both legs, which the Trips tab shows
  // as one round trip (DXB->BCN->DXB). The form clears immediately on save -
  // both legs are already combined into the one preview, so there's nothing left to chain. ---
  await openAddForm(page, TURNAROUND.pickedDate);
  await page.getByTestId("flightno-input").fill(TURNAROUND.outbound.flightNo.slice(2));
  await expect(autofillCard).toBeVisible();
  await expect(autofillCard).toContainText(`${TURNAROUND.outbound.origin} → ${TURNAROUND.outbound.dest}`);

  await page.getByTestId("append-flight").click();
  await page.getByTestId("append-flightno-input").fill(TURNAROUND.appended.flightNo.slice(2));
  // Scoped to the day card, not the whole page: the tab bar's center + button also has an
  // accessible name of "Add" (its aria-label, no visible text), which `getByRole` would
  // otherwise match too.
  await dayCard.getByRole("button", { name: "Add", exact: true }).click();

  const appendedCard = page.getByTestId("appended-card");
  await expect(appendedCard).toBeVisible();
  await expect(appendedCard).toContainText(TURNAROUND.appended.flightNo);
  await expect(appendedCard).toContainText(`${TURNAROUND.appended.origin} → ${TURNAROUND.appended.dest}`);

  await page.getByRole("button", { name: /add to roster/i }).click();
  await expect(page.getByTestId("delete-trip")).toBeVisible();

  await expect(page.getByTestId(`calendar-day-${TURNAROUND.pickedDate}`)).toHaveClass(/bg-accent-soft/);
  // EK9998 leaves Barcelona on the 15th and lands Dubai at 00:05 on the 16th, so the 16th is the
  // morning she gets home — marked as an arrival, not as another day away.
  await expect(page.getByTestId(`calendar-day-${TURNAROUND.landingDate}`)).toHaveClass(
    /bg-accent-soft/,
  );
  await expect(page.getByTestId(`day-mark-${TURNAROUND.landingDate}`)).toContainText("DXB");

  // ONE trip carrying both legs, not two trips — the whole point of appending before saving.
  const turnaround = await rosterTrips(page);
  expect(turnaround).toHaveLength(1);
  expect(turnaround[0]!.flights).toHaveLength(2);

  await clearRoster(page);

  // --- Scenario 1: unknown flight -> lookup miss -> manual expand -> full save. The form
  // clears on save (rapid-entry chaining is gone), so a second manual add happens via a fresh
  // empty-day form on the following day. PICKED_DATE (2026-11-12) is after both scenarios
  // above (2026-09-10..16), so the calendar's forward-only navigation reaches it without ever
  // needing to go back. ---
  await openAddForm(page, PICKED_DATE);
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByText(/unknown flight/i)).toBeVisible();
  await expect(page.getByTestId("autofill-card")).not.toBeVisible();

  await page.getByTestId("manual-expand").click();

  // Manual form prefilled with the picked date, empty times - fill the rest by hand.
  const depInput = page.getByLabel(/departure \(local\)/i);
  await expect(depInput).toHaveValue(`${PICKED_DATE}T00:00`);

  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill("DXB");
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill("LHR");
  await page.getByLabel(/^dest$/i).blur();
  await depInput.fill(`${PICKED_DATE}T09:15`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${PICKED_DATE}T13:35`);
  await page.getByRole("button", { name: /add to roster/i }).click();

  // Save flips the day to the trip view - no rapid-entry banner/next-date suggestion to check
  // anymore.
  await expect(page.getByTestId("delete-trip")).toBeVisible();
  await expect(page.getByTestId(`calendar-day-${PICKED_DATE}`)).toHaveClass(/bg-accent-soft/);

  // --- Second manual add, on the following day via a fresh empty-day form. ---
  const nextIso = "2026-11-13";
  await openAddForm(page, nextIso);
  await page.getByTestId("flightno-input").fill(UNKNOWN_FLIGHT_NO.slice(2));
  await expect(page.getByText(/unknown flight/i)).toBeVisible();
  await page.getByTestId("manual-expand").click();
  await expect(depInput).toHaveValue(`${nextIso}T00:00`);
  await page.getByLabel(/flight no/i).fill(UNKNOWN_FLIGHT_NO);
  await page.getByLabel(/^origin$/i).fill("DXB");
  await page.getByLabel(/^origin$/i).blur();
  await page.getByLabel(/^dest$/i).fill("LHR");
  await page.getByLabel(/^dest$/i).blur();
  await depInput.fill(`${nextIso}T09:15`);
  await page.getByLabel(/arrival \(local\)/i).fill(`${nextIso}T13:35`);
  await page.getByRole("button", { name: /add to roster/i }).click();
  await expect(page.getByTestId("delete-trip")).toBeVisible();

  // Both manual-entry days marked on the calendar.
  await expect(page.getByTestId(`calendar-day-${PICKED_DATE}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`calendar-day-${nextIso}`)).toHaveClass(/bg-accent-soft/);

  // Two separate manual trips, one leg each.
  const manualTrips = await rosterTrips(page);
  expect(manualTrips).toHaveLength(2);
  expect(manualTrips.flatMap((t) => t.flights)).toHaveLength(2);
  await clearRoster(page);

  // --- Scenario 2: multi-leg smoke - EK384 lookup renders both legs in the autofill card. ---
  await openAddForm(page, PICKED_DATE);
  await page.getByTestId("flightno-input").fill(EK384.flightNo.slice(2));

  await expect(autofillCard).toBeVisible();
  await expect(autofillCard).toContainText(`${EK384.leg0.origin} → ${EK384.leg0.dest}`);
  await expect(autofillCard).toContainText(`${EK384.leg1.origin} → ${EK384.leg1.dest}`);

  // Two legs -> two dep/arr time inputs rendered in the card.
  await expect(page.getByTestId("autofill-dep")).toHaveCount(2);
  await expect(page.getByTestId("autofill-arr")).toHaveCount(2);

  // Not saving this one - no seeded trip to clean up, and there's no sheet to dismiss (the
  // form lives on the day card; simply leaving it in preview state is enough). No sign-out
  // here: the shared session (auth.setup.ts) must stay valid for roster.spec.ts and
  // share.spec.ts, which run after this file and rely on the same storageState-backed server
  // session — better-auth's sign-out deletes the session server-side, not just the local
  // cookie, so signing out here would invalidate the session for every later spec too. Real
  // sign-out UI coverage lives in share.spec.ts, the last file to run.
});

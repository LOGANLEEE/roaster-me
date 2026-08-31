import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Test account used across the spec — idempotent because each run deletes its own trip. */
export const E2E_EMAIL = "e2e@local.test";

/**
 * DXB -> LHR fixture with a computable expected report time (dep - 90min, see
 * shared/src/time.ts reportDefault): dep wall 09:15 Asia/Dubai -> report wall 07:45.
 * After the spec edits dep to 10:15, report becomes 08:45.
 *
 * EK001 is a real seeded flight_schedules row (DXB->LHR, daily) - the autofill card
 * prefills different times (08:35/12:40) than this fixture, but the stepper lets those
 * be edited inline before save, so the spec overwrites them to keep the same expected
 * report-time math across the manual-vs-autofill rewrite.
 */
export const FIXTURE = {
  flightNo: "EK001",
  origin: "DXB",
  dest: "LHR",
  dep: "2026-09-10T09:15",
  arr: "2026-09-10T13:35",
  depTime: "09:15",
  arrTime: "13:35",
  depEdited: "2026-09-10T10:15",
  reportBefore: "07:45",
  reportAfter: "08:45",
};

/** Unknown-to-schedule flight number used to exercise the manual-entry fallback path. Shares
 * the app's fixed "EK" airline-code prefix — AddTripForm.tsx's flightno-input only accepts
 * typed digits, the prefix itself isn't user-typeable — so it can be composed by filling just
 * its digit suffix, the same way every other fixture flight number in this suite is. */
export const UNKNOWN_FLIGHT_NO = "EK999";

/**
 * DXB -> SYD -> CHC, EK412 (scripts/ek-schedules.json, real seeded 2-leg schedule): a
 * multi-day trip whose away-span (first-leg departure's to last-leg arrival's LOCAL
 * calendar date, in the home base tz Asia/Dubai) covers TWO calendar days, not one - useful
 * fixture shape since a single-leg, same-day flight like FIXTURE/EK001 can't exercise a
 * multi-day span at all. Picked date 2026-09-10: leg 0 departs 10:15 Asia/Dubai the picked
 * day, arrives Sydney the next day; leg 1 departs Sydney the same day it arrives and lands
 * in Christchurch a bit later - the whole pairing's away-span in Asia/Dubai local dates is
 * 2026-09-10 through 2026-09-11 (verified against shared/src/time.ts's wallToUtc/localDateKey).
 */
export const EK412 = {
  flightNo: "EK412",
  origin: "DXB",
  dest: "SYD",
  depTime: "10:15",
  arrTime: "06:00",
  // dep 10:15 Asia/Dubai (no DST) - 90min = report 08:45 local, year-round.
  reportLocal: "08:45",
  pickedDate: "2026-09-10",
  spanEndDate: "2026-09-11",
  // A free day after the span ends - nothing suggests it (rapid-entry chaining is gone), so
  // this is just the picked date for the suite's own second sequential add of the same flight.
  nextFreeDate: "2026-09-12",
  // A second EK412 pairing re-added (by typing the same flight number again) on
  // `nextFreeDate` spans 2026-09-12 through 2026-09-13 (same 2-day shape, one day later) -
  // also verified against shared/src/time.ts.
  secondPairingSpanEndDate: "2026-09-13",
};

/**
 * Clicks a calendar day cell identified by `iso` ("YYYY-MM-DD") ONCE, advancing the visible
 * month via the "next month" chevron first if the cell isn't rendered yet (the day-picker
 * and trip calendars both default to the current month view and only render 6 weeks of
 * the active month/adjacent-month spillover). A single tap SELECTS the day, showing its
 * detail card on the calendar-home grid — for an empty day that card IS the add-trip form
 * (no second tap, no sheet); use `openAddForm` to also wait for that form to be ready.
 */
/**
 * Waits out the calendar's month slide.
 *
 * Stepping a month animates the whole track for 480ms, and a day cell inside it is NOT where its
 * bounding box says it is: measured 2026-08-31 against a local build, a press on the cell's own
 * reported box landed on `<html>` and selected nothing — 10 times out of 10 during the slide, and
 * 0 times out of 10 once it had settled.
 *
 * Playwright's own actionability check does not save you here. It reported "element is visible,
 * enabled and stable" and clicked, and the click was still lost: `--ease-snap` moves sub-pixel
 * amounts through the tail of the curve, which samples as stable while the cell is travelling.
 * That is what blocked three deploys on 2026-08-31 — `crew.spec` steps a month and immediately
 * asks for the add form, and the whole failing sequence took 200ms.
 *
 * Two frames first, so a transition that has only just been committed is registered before the
 * list is read. Under reduced motion the transition is switched off entirely and the empty list
 * is a legitimate "already settled".
 */
async function waitForMonthSettled(page: Page): Promise<void> {
  await page.getByTestId("calendar-track").evaluate(async (track) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(track.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}

export async function pickCalendarDay(page: Page, iso: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const cell = page.getByTestId(`calendar-day-${iso}`);
    if (await cell.isVisible().catch(() => false)) {
      await cell.click();
      return;
    }
    await page.getByTestId("calendar-next").click();
    await waitForMonthSettled(page);
  }
  throw new Error(
    `calendar-day-${iso} never became visible after 24 months of navigation`,
  );
}

/**
 * Selects `iso` on the calendar-home grid (via `pickCalendarDay`) and waits for its inline
 * add-trip form to be ready — the empty-day detail card renders the form directly, one tap,
 * no bottom sheet.
 */
export async function openAddForm(page: Page, iso: string): Promise<void> {
  await pickCalendarDay(page, iso);
  await page.getByTestId("flightno-input").waitFor();
}

/** Fetches the most recently captured dev-fallback OTP via the E2E_TEST_MODE-gated route. */
async function fetchLastOtp(page: Page, email: string): Promise<string> {
  const res = await page.request.get(
    `/api/__e2e/last-otp?email=${encodeURIComponent(email)}`,
  );
  if (!res.ok()) {
    throw new Error(
      `__e2e/last-otp failed: ${res.status()} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { otp: string };
  return body.otp;
}

/** Drives the full landing -> email OTP sign-in flow via the real UI. The email field is on
 * the landing surface itself (no separate login screen/CTA to navigate through first). */
export async function signInThroughUi(
  page: Page,
  email = E2E_EMAIL,
): Promise<void> {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole("button", { name: /send code/i }).click();

  const codeInput = page.getByLabel(/code/i);
  await codeInput.waitFor();
  const otp = await fetchLastOtp(page, email);
  await codeInput.fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Signs out via the Settings tab (Plan6 T2 moved the sign-out control off the header). */
export async function signOutThroughUi(page: Page): Promise<void> {
  await page.getByTestId("tab-settings").click();
  await page.getByRole("button", { name: /sign out/i }).click();
}

/** One trip as /api/trips returns it — enough to count trips and their legs. */
type RosterLeg = {
  id: string;
  flightNo: string;
  dest: string;
  operating: boolean;
};
/** `flights` is only the sectors the crew works; `continuation` is the aircraft's onward
 * routing, which the API keeps out of `flights` on purpose. */
type RosterTrip = {
  id: string;
  flights: RosterLeg[];
  continuation?: RosterLeg[];
};

/**
 * The signed-in account's roster, straight from the API the app itself calls.
 *
 * Counting duties used to mean opening the Trips tab and counting rendered rows. That tab is
 * gone (the calendar is the only roster surface now), and asserting against the API is the
 * better check anyway: "one trip with two legs" and "two trips with one leg each" look
 * identical in a flat list of rows, and it was the flat list these specs were counting.
 */
export async function rosterTrips(page: Page): Promise<RosterTrip[]> {
  const res = await page.request.get("/api/trips");
  if (!res.ok()) throw new Error(`GET /api/trips failed: ${res.status()}`);
  return ((await res.json()) as { trips: RosterTrip[] }).trips;
}

/**
 * Empties the account's roster through the API, then reloads so the UI reflects it.
 *
 * Deliberately not driven through the UI: the old version clicked a row, a delete and a
 * confirm up to five times and swallowed every timeout, so a cleanup that silently failed
 * left the next spec's assertions to fail somewhere unrelated. This either empties the
 * roster or throws here.
 */
export async function clearRoster(page: Page): Promise<void> {
  for (const trip of await rosterTrips(page)) {
    const res = await page.request.delete(`/api/trips/${trip.id}`);
    if (!res.ok())
      throw new Error(`DELETE /api/trips/${trip.id} failed: ${res.status()}`);
  }
  const left = await rosterTrips(page);
  if (left.length > 0)
    throw new Error(
      `roster not empty after cleanup: ${left.length} trip(s) left`,
    );
  await page.reload();
  await page.getByTestId("calendar-grid").waitFor({ timeout: 20_000 });
}

/**
 * Waits until the SERVER agrees the roster holds `count` trips.
 *
 * Use this immediately after adding or deleting a duty, before asserting anything on screen.
 * `expect(page.getByTestId("delete-trip")).toHaveCount(n)` on its own conflates two different
 * failures — the write never happened, or it happened and the calendar had not repainted — and
 * with the suite's 5s expect timeout a write that merely takes longer than that is
 * indistinguishable from a broken feature. Both `away-band.spec.ts` and `delete-account.spec.ts`
 * blocked a deploy on exactly that, at exactly that assertion.
 *
 * The window is deliberately wider than the default: the point is to let a slow write finish,
 * while a genuinely missing trip still fails and now says which of the two it was.
 */
export async function expectRosterCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await rosterTrips(page)).length, { timeout: 10_000 })
    .toBe(count);
}

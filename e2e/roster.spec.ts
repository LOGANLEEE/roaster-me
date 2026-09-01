import { expect, test } from "@playwright/test";
import { E2E_EMAIL, EK412, FIXTURE, clearRoster, openAddForm, pickCalendarDay, rosterTrips } from "./helpers";

/**
 * Full e2e coverage of the Plan 6 tabbed, calendar-first UX against a real `wrangler dev`
 * (local D1). Starts already signed in — the `chromium` project's storageState, written once
 * by auth.setup.ts, is loaded fresh for this test's own context, so this file sends zero OTPs
 * of its own. (The real sign-in UI walk — landing page's inline email OTP form, verified — is
 * asserted once in auth.setup.ts instead of being duplicated here.)
 *
 * This file does NOT sign out: better-auth's sign-out deletes the session server-side, not
 * just the local cookie, so calling it here would invalidate the SAME session
 * share.spec.ts's storageState-backed context relies on (it runs after this file). Real
 * sign-out UI coverage lives in share.spec.ts, the last file in the suite to run.
 *
 * Full flow covered: calendar home, the inline add-trip form on an empty day's detail card,
 * autofill add (a save clears the form and refetches, flipping the card to the trip view - no
 * bottom sheet), a second EK412 pairing added the same way on a later free day, both days
 * marked on the calendar, both pairings on the roster, an edit on the day card, and the deletes.
 *
 * Idempotent by construction: any trip left over from a prior failed run is deleted by the
 * cleanup loop below before assertions begin, so re-running never accumulates state.
 *
 * Auth coverage stays on the email OTP path only: Google's real OAuth consent screen
 * actively blocks automated sign-in, so there's no reliable way to drive the "Continue
 * with Google" button through Playwright. That path is covered by unit tests (Landing.test.tsx)
 * that assert authClient.signIn.social is called correctly, plus manual verification.
 */
test("calendar home -> inline add-trip form -> autofill add -> sequential add -> edit on the day card -> delete both", async ({
  page,
}) => {
  // Already signed in via the shared storageState (auth.setup.ts) — go straight to the app.
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await expect(page.getByTestId("calendar-next")).toBeVisible();

  // Clean slate: delete any trip(s) left over from a previous failed run — through the API,
  // not by clicking through a list. The Trips tab that list lived on is gone, and the loop
  // that drove it swallowed every timeout, so a cleanup that quietly failed used to surface
  // as an unrelated assertion failing later.
  await clearRoster(page);
  // An empty roster shows today's own day card, not a "No trips yet" panel — that panel was
  // deleted with the preview card, because its only action was to select today.
  await expect(page.getByTestId("day-detail-card")).toContainText(/no duty/i);

  // --- Tap a day on the calendar home: single tap selects it and, since it's empty, its
  // detail card IS the add-trip form (openAddForm selects + waits for the form). ---
  const firstIso = EK412.pickedDate;
  await openAddForm(page, firstIso);

  // EK412 autofill: real seeded DXB->SYD->CHC schedule row (scripts/ek-schedules.json), a
  // genuinely multi-day pairing — its away-span (home-base local dates) runs firstIso
  // through EK412.spanEndDate, TWO calendar days, not one. Exercising the calendar's
  // whole-span marking (both days get bg-accent-soft, not just the tapped one) is the point
  // of this scenario, not incidental — a same-day single-leg flight couldn't cover it.
  await page.getByTestId("flightno-input").fill(EK412.flightNo.slice(2));
  const autofillCard = page.getByTestId("autofill-card");
  await expect(autofillCard).toBeVisible();
  await expect(autofillCard).toContainText(`${EK412.origin} → ${EK412.dest}`);
  await expect(page.getByTestId("autofill-dep").first()).toHaveValue(EK412.depTime);
  await expect(page.getByTestId("autofill-arr").first()).toHaveValue(EK412.arrTime);
  await page.getByRole("button", { name: /add to roster/i }).click();

  // --- Save clears the form and the parent's refetch flips the tapped day's own detail card
  // (it stays selected throughout) from the add form over to the trip view. ---
  await expect(page.getByTestId("delete-trip")).toBeVisible();
  await expect(page.getByTestId("flightno-input")).not.toBeVisible();
  await expect(page.getByTestId(`calendar-day-${firstIso}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`calendar-day-${EK412.spanEndDate}`)).toHaveClass(/bg-accent-soft/);
  // A free day after the span ends must NOT be marked.
  const secondPickedDate = EK412.nextFreeDate;
  await expect(page.getByTestId(`calendar-day-${secondPickedDate}`)).not.toHaveClass(/bg-accent-soft/);

  // --- Second pairing: tap the next free day and add the SAME flight again the normal way -
  // no recent-flight chip anymore, just type it. ---
  await openAddForm(page, secondPickedDate);
  await page.getByTestId("flightno-input").fill(EK412.flightNo.slice(2));
  await expect(autofillCard).toBeVisible();
  await page.getByRole("button", { name: /add to roster/i }).click();
  await expect(page.getByTestId("delete-trip")).toBeVisible();

  // The first pairing's span AND the second pairing's span are all marked.
  await expect(page.getByTestId(`calendar-day-${firstIso}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`calendar-day-${EK412.spanEndDate}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`calendar-day-${secondPickedDate}`)).toHaveClass(/bg-accent-soft/);
  await expect(page.getByTestId(`calendar-day-${EK412.secondPairingSpanEndDate}`)).toHaveClass(/bg-accent-soft/);

  // --- Both pairings are on the roster: two trips, two legs each. Asserted through the API
  // rather than by counting rendered rows — a flat row count cannot tell two two-leg trips
  // apart from one four-leg trip, which is exactly the distinction that matters here. ---
  const saved = await rosterTrips(page);
  expect(saved).toHaveLength(2);
  expect(saved.flatMap((t) => t.flights)).toHaveLength(4);

  // --- Edit on the day card itself: the pencil re-runs the same lookup pipeline as adding,
  // and saving is create-then-delete, so the day ends up carrying the NEW flight and the old
  // trip is gone. This is the only edit path left now that the full-screen detail is
  // deleted — the leg-level time edit went with it. ---
  await pickCalendarDay(page, firstIso);
  await page.getByTestId("day-detail-action").click();
  await page.getByTestId("card-edit-flightno").fill(FIXTURE.flightNo.slice(2));
  const saveEdit = page.getByTestId("card-edit-save");
  await expect(saveEdit).toBeEnabled({ timeout: 20_000 });
  await saveEdit.click();

  const dayCard = page.getByTestId("day-detail-card");
  await expect(dayCard).toContainText(`${FIXTURE.origin} → ${FIXTURE.dest}`, { timeout: 20_000 });
  await expect(dayCard).not.toContainText(EK412.flightNo);
  // Still two trips: the edit replaced one, it did not add a third.
  expect(await rosterTrips(page)).toHaveLength(2);

  // --- Delete both, and confirm the roster really is empty (not just the screen). ---
  await clearRoster(page);
  expect(await rosterTrips(page)).toHaveLength(0);
  await expect(page.getByTestId("day-detail-card")).toContainText(/no duty/i);
});

test.beforeAll(() => {
  // Sanity: the account used across this suite must be the documented test address.
  expect(E2E_EMAIL).toBe("e2e@local.test");
});

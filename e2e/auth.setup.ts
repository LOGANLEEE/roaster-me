import { expect, test as setup } from "@playwright/test";
import { E2E_EMAIL, signInThroughUi } from "./helpers";
import { AUTH_FILE } from "./playwright.config";

/**
 * Runs once, before every spec file, as its own Playwright project (see
 * playwright.config.ts's `setup` project + the `chromium` project's `dependencies`).
 * Signs in exactly ONE time for the whole suite and persists the authenticated session to
 * AUTH_FILE, which every spec file's default `page` context then loads via the `chromium`
 * project's `use.storageState` — so autofill.spec.ts, roster.spec.ts, and share.spec.ts all
 * start already signed in, with zero further OTP sends between them.
 *
 * This is where the suite's ONLY assertion of the real sign-in UI walk (`/signin`'s inline
 * email OTP form -> verified, with the code field appearing on the same surface) now lives; it
 * used to be duplicated at the top of roster.spec.ts's test, which called `signInThroughUi`
 * itself.
 *
 * Unlike storageState (a client-side snapshot Playwright re-reads fresh per test file),
 * better-auth's session is server-backed: calling sign-out from ANY spec deletes the shared
 * session on the server, invalidating it for every other spec's context too, even though
 * each loads its own copy of the same file. So exactly one spec — share.spec.ts, the LAST
 * file in the run order — is allowed to sign out; autofill.spec.ts and roster.spec.ts
 * (which run earlier) deliberately never call `signOutThroughUi`.
 *
 * better-auth's email-OTP rate limit (`worker/src/auth.ts`, IP-keyed, window 60s max 3) is
 * why this consolidation exists: 3 separate per-file sign-ins (one OTP each) sat right at
 * the ceiling and any Playwright retry pushed the suite over it. One sign-in total leaves
 * headroom for retries and future specs.
 */
setup("authenticate", async ({ page }) => {
  await page.goto("/");
  // Exactly one h1, which is the real invariant here: App.tsx skips its own chrome header on a
  // signed-out screen so the page heading is not announced twice. This used to assert zero
  // `<header>` elements as a proxy, which stopped meaning that on 2026-09-04 — Marketing owns a
  // real masthead `<header>` of its own, and the h1 count is what actually mattered.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /danyeowa/i, level: 1 })).toBeVisible();

  await signInThroughUi(page, E2E_EMAIL);

  await expect(page.getByTestId("tab-calendar")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});

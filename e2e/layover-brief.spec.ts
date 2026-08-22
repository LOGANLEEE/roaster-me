import { expect, test } from "@playwright/test";
import { UNKNOWN_FLIGHT_NO, clearRoster, expectRosterCount, openAddForm, pickCalendarDay } from "./helpers";

/**
 * The layover brief: how long she is actually free down-route, and a button that packs that
 * context into text for whichever assistant she already uses.
 *
 * Two things here are only true in a real engine and so are measured rather than trusted:
 * the panel has to appear on the day in the MIDDLE of a layover — which has no duty at all,
 * and is therefore the branch that renders "no duty" and nothing else — and the hotel field
 * has to compute to at least 16px or iOS zooms the whole layout on focus.
 */

// Clear of every other spec's dates, so no leftover can fake a pairing.
const OUT_DAY = "2027-05-10";
const LAYOVER_DAY = "2027-05-11"; // no duty at all — the branch that matters
const BACK_DAY = "2027-05-12";

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
  await expect(page.getByText(/unknown flight/i)).toBeVisible();
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

test("layover brief: free-until-report on the empty middle day, and the copy carries it", async ({
  page,
  context,
}) => {
  test.slow(); // two manual entries plus clipboard + geometry checks

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:8787",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("tab-calendar")).toBeVisible();
  await clearRoster(page);

  // Out of base on the 10th, back on the 12th. The 11th belongs to neither trip.
  await openAddForm(page, OUT_DAY);
  await addSector(page, OUT_DAY, "DXB", "SYD", "03:00", "22:00", 1);
  await openAddForm(page, BACK_DAY);
  await addSector(page, BACK_DAY, "SYD", "DXB", "18:00", "23:00", 2);

  // --- The middle day: no duty, and the panel is the only thing on it worth reading. ---
  await pickCalendarDay(page, LAYOVER_DAY);
  await expect(page.getByTestId("day-detail-card")).toContainText(/no duty/i);

  const panel = page.getByTestId("layover-brief");
  await expect(panel).toBeVisible();
  // Inside the day card, not stacked beside it — one day should read as one thing.
  await expect(page.getByTestId("day-detail-card").getByTestId("layover-brief")).toBeVisible();
  // The header shows the resolved city; the bare IATA is only the fallback before it lands.
  await expect(panel).toContainText("Layover · Sydney");

  // Free time is landing -> REPORT, never landing -> departure. Landing 22:00 Sydney on the
  // 10th, report 90 minutes before an 18:00 departure on the 12th: 1d 18h, not 1d 20h.
  await expect(page.getByTestId("layover-free")).toHaveText("1d 18h");

  // --- The hotel field must not trip iOS zoom. ---
  const hotelFontPx = await page
    .getByTestId("layover-hotel")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(hotelFontPx).toBeGreaterThanOrEqual(16);

  // --- Nothing may scroll sideways at 390px. ---
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "layover panel must not widen the page at 390px").toBeLessThanOrEqual(0);

  // --- The copy carries the roster context, including the hotel once given. ---
  await page.getByTestId("layover-hotel").fill("Rydges Sydney Central");
  await page.getByTestId("copy-layover-brief").click();
  await expect(page.getByTestId("copy-layover-brief")).toHaveText(/copied/i);

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("SYD");
  expect(copied).toContain("FREE    1d 18h from landing to report");
  expect(copied).toContain("HOTEL   Rydges Sydney Central");
  // Crew ride a company shuttle in — an airport-to-city fare is the wrong question.
  expect(copied).toContain("crew shuttle");
  expect(copied).not.toContain("location unknown");

  // --- It is also there on the day she lands, which does have a duty. ---
  await pickCalendarDay(page, OUT_DAY);
  await expect(page.getByTestId("layover-brief")).toBeVisible();

  // --- Weather. Stubbed rather than live: the suite must not depend on a third party being
  //     up, and the point being tested is what the card does with each answer, not that
  //     Open-Meteo replies. Both bodies are the shapes the real API actually returns. ---
  await page.unrouteAll();
  await page.route("**api.open-meteo.com**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // Verbatim from the live API for a date past its ~16-day horizon.
      body: JSON.stringify({
        error: true,
        reason: "Parameter 'start_date' is out of allowed range from 2026-05-20 to 2026-09-05",
      }),
    }),
  );
  await pickCalendarDay(page, LAYOVER_DAY);
  // No forecast exists this far out — and the card must say so rather than draw a seasonal
  // average that looks exactly like a real one.
  await expect(page.getByTestId("layover-weather-pending")).toBeVisible();
  await expect(page.getByTestId("layover-weather")).toHaveCount(0);

  // --- While the lookup is still in flight the card must NOT explain an answer it does not
  //     have yet. "No forecast yet — usually available about two weeks ahead" is a reason,
  //     and during the fetch there are no grounds for it. ---
  await page.unrouteAll();
  let releaseForecast: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseForecast = resolve;
  });
  await page.route("**api.open-meteo.com**", async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: true, reason: "still out of range" }),
    });
  });
  await pickCalendarDay(page, OUT_DAY);
  await pickCalendarDay(page, LAYOVER_DAY);
  await expect(page.getByTestId("layover-weather-loading")).toBeVisible();
  await expect(page.getByTestId("layover-weather-pending")).toHaveCount(0);
  releaseForecast!();
  await expect(page.getByTestId("layover-weather-pending")).toBeVisible();

  // Now the same station with a forecast. A refusal is never cached, so this refetches.
  await page.unrouteAll();
  await page.route("**api.open-meteo.com**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        daily: {
          time: ["2027-05-10", "2027-05-11", "2027-05-12"],
          weather_code: [95, 3, 0],
          temperature_2m_max: [21.4, 19.8, 22.1],
          temperature_2m_min: [12.6, 11.9, 13.0],
          precipitation_probability_max: [86, 20, 0],
          sunrise: ["2027-05-10T06:30", "2027-05-11T06:31", "2027-05-12T06:32"],
          sunset: ["2027-05-10T17:02", "2027-05-11T17:01", "2027-05-12T17:00"],
        },
      }),
    }),
  );
  // --- The flight card wears the destination's sky for the day it lands. ---
  await pickCalendarDay(page, OUT_DAY);
  const card = page.getByTestId("day-detail-card").first();
  await expect(card).toHaveAttribute("data-sky", "storm");
  await expect(card).toHaveClass(/\bsky\b/);
  await expect(page.getByTestId("card-sky").first()).toContainText("13–21° · Thunderstorm · rain 86%");

  // The contrast MATHS lives in lib/contrast.test.ts, against the real tokens.css. What only a
  // real engine can show is whether those tokens are the ones actually in effect — the scoped
  // `.sky .text-report` override has to beat the plain utility class, or the report time gets
  // painted in a colour measured at 3.5:1.
  const onSky = await card.evaluate((el) => {
    const report = el.querySelector(".text-report") as HTMLElement | null;
    const muted = el.querySelector(".text-ink-muted") as HTMLElement | null;
    return {
      report: report && getComputedStyle(report).color,
      muted: muted && getComputedStyle(muted).color,
    };
  });
  expect(onSky.report, "report time must use --color-report-on-sky").toBe("rgb(255, 213, 126)");
  expect(onSky.muted, "muted text must use --color-ink-muted-on-sky").toBe("rgb(154, 163, 181)");

  // --- The weather mark moves, so it can be spotted rather than read past. ---
  const glyph = card.locator("svg[data-wx]");
  await expect(glyph).toHaveAttribute("data-wx", "storm");
  const running = await glyph.evaluate((el) => {
    const drop = el.querySelector(".wx-d1");
    return drop ? getComputedStyle(drop).animationName : null;
  });
  expect(running, "the falling drops must actually be animating").toBe("wx-fall");

  const skyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(skyOverflow, "the sky must not widen the card at 390px").toBeLessThanOrEqual(0);

  await pickCalendarDay(page, LAYOVER_DAY);

  const weather = page.getByTestId("layover-weather");
  await expect(weather).toBeVisible();
  await expect(weather).toContainText("Thunderstorm");
  await expect(weather).toContainText("13–21°");
  await expect(weather).toContainText("86%");
  // Sunset rides along with the forecast already fetched — on a layover the question is how
  // much light is left.
  await expect(weather).toContainText("↓17:02");
  // CC BY 4.0 requires the credit, and it has to be on the card, not buried in a doc.
  await expect(weather).toContainText("Open-Meteo");

  // --- Pointers rather than a second copy of somebody else's data. ---
  const lookup = page.getByTestId("layover-lookup");
  await expect(lookup.getByRole("link", { name: /city guide/i })).toHaveAttribute(
    "href",
    /wikivoyage\.org.*Sydney/,
  );
  await expect(lookup.getByRole("link", { name: /what's on/i })).toHaveAttribute(
    "href",
    /Sydney/,
  );

  // The extra column must not widen the card.
  const stillNoOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(stillNoOverflow, "forecast row must not widen the page at 390px").toBeLessThanOrEqual(0);

  // The copy carries the real numbers, so the assistant is never asked to guess them.
  await page.getByTestId("copy-layover-brief").click();
  const withWeather = await page.evaluate(() => navigator.clipboard.readText());
  expect(withWeather).toContain("WEATHER (actual forecast, Open-Meteo)");
  expect(withWeather).toContain("Thunderstorm · rain 86%");
  expect(withWeather).toContain("3. What to pack given that forecast");
  expect(withWeather).not.toContain("3. The weather across those dates");

  await page.unrouteAll();

  // --- And absent once she is home: the day after the return is not a layover. ---
  await pickCalendarDay(page, "2027-05-14");
  await expect(page.getByTestId("layover-brief")).toHaveCount(0);

  await clearRoster(page);
});

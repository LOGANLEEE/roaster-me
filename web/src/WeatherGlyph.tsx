import type { SkyKind } from "./lib/useSky";

/**
 * A small moving weather mark for the flight card's header.
 *
 * Movement is the point: the sky behind the card says the mood, but a still field is easy to
 * read past. Something falling catches the eye at a glance, which is what "check the weather"
 * actually is on a roster screen.
 *
 * Every animation here is `transform` or `opacity` on a handful of small nodes — never the
 * card's own background, which would repaint the whole surface every frame. All of it is
 * scoped to `prefers-reduced-motion: no-preference` in tokens.css, so under reduced motion the
 * glyph is simply a static icon rather than a hidden one.
 *
 * Drawn rather than emoji: emoji render differently per platform, cannot take a colour token,
 * and this one has to sit on a dark sky in both themes.
 */
export function WeatherGlyph({ kind }: { kind: SkyKind }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "shrink-0",
  };

  if (kind === "clear") {
    return (
      <svg {...common} data-wx="clear">
        <circle cx="12" cy="12" r="4" />
        <g className="wx-rays">
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </g>
      </svg>
    );
  }

  const cloud = <path d="M7 17h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 17z" />;

  if (kind === "cloud") {
    return (
      <svg {...common} data-wx="cloud">
        <g className="wx-drift">{cloud}</g>
      </svg>
    );
  }

  if (kind === "snow") {
    return (
      <svg {...common} data-wx="snow">
        {cloud}
        <g className="wx-flakes">
          <circle className="wx-f1" cx="9" cy="20" r="0.9" fill="currentColor" stroke="none" />
          <circle className="wx-f2" cx="13" cy="20" r="0.9" fill="currentColor" stroke="none" />
          <circle className="wx-f3" cx="17" cy="20" r="0.9" fill="currentColor" stroke="none" />
        </g>
      </svg>
    );
  }

  // rain and storm share the falling drops; storm adds the flash.
  return (
    <svg {...common} data-wx={kind}>
      {cloud}
      <g className="wx-drops">
        <path className="wx-d1" d="M9 19v2.5" />
        <path className="wx-d2" d="M13 19v2.5" />
        <path className="wx-d3" d="M17 19v2.5" />
      </g>
      {kind === "storm" && (
        <path
          className="wx-bolt"
          d="M13 12.5l-2.5 4h3l-1 3.5"
          stroke="var(--color-report-on-sky)"
        />
      )}
    </svg>
  );
}

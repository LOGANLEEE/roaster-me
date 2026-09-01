import type { SkyKind } from "./lib/useSky";

/**
 * The destination's weather, drawn over the card.
 *
 * Two earlier attempts and why they failed, so neither gets retried:
 *
 * 1. Translating the card's hatched `::before`. A repeating gradient is uniform edge to edge,
 *    so moving it slides a corduroy pattern. No tuning fixes a wrong shape.
 * 2. Absolutely-positioned `<span>`s. Better — sparse marks with gaps DO read as rain — but a
 *    rectangle can only ever be a streak. `clear` and `cloud` got nothing at all, and side by
 *    side the two were indistinguishable: a flat dark card either way.
 *
 * So: real drawings. SVG gives shapes a div cannot — a sun with rays, a cloud silhouette, a
 * tapered raindrop, a bolt — and one element carries the whole field.
 *
 * NO SVG FILTERS. Soft edges come from radial gradients instead of `feGaussianBlur`, because a
 * filtered layer re-rasterises every time it is transformed, and this runs on a phone. Every
 * animation is `transform` or `opacity` on a group, nothing else.
 *
 * Depth is speed, not size: the back layer of every kind moves slowest and sits faintest. That
 * is the one thing the motion reference was clear about, and it is what stops a field of marks
 * reading as a single sheet.
 *
 * Reduced motion is handled in tokens.css, not here — `clear` and `cloud` keep their art
 * standing still, which is legible, while the falling kinds are hidden outright and the static
 * hatch underneath carries them. Frozen raindrops look broken; a still sun does not.
 */

/**
 * How hard it is coming down, 0 to 1, from the WMO code the forecast already carries.
 *
 * "Rain" is not one thing to someone packing a bag: WMO separates slight (61) from moderate
 * (63) from heavy (65), and the card was drawing all three identically. Density and speed both
 * ride this, so heavy rain is more drops falling faster rather than a relabelled drizzle.
 */
const INTENSITY: Readonly<Record<number, number>> = {
  51: 0.15, 53: 0.35, 55: 0.55, 56: 0.3, 57: 0.55, // drizzle, freezing drizzle
  61: 0.45, 63: 0.7, 65: 1, 66: 0.5, 67: 0.9, //      rain, freezing rain
  80: 0.5, 81: 0.75, 82: 1, //                        showers
  71: 0.3, 73: 0.6, 75: 0.95, 77: 0.35, 85: 0.5, 86: 0.9, // snow
  95: 0.75, 96: 1, 99: 1, //                          thunderstorm, with hail
  2: 0.4, 3: 0.85, 45: 1, 48: 1, //                   partly cloudy, overcast, fog
};

/** Deterministic pseudo-random in [0, 1). `Math.random()` would reshuffle the whole field on
 * every re-render, and this card re-renders whenever the day changes or a forecast lands. */
function spread(index: number, salt: number): number {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A raindrop: a short slanted streak, faded at the top so it has no hard cap.
 *
 * The slant is baked into the path (16 degrees, the same angle the static hatch is drawn at)
 * rather than applied as a `transform` — the fall animation owns transform, and a rotation
 * there would be overwritten by it. */
function drops(count: number, seed: number, force: number) {
  return Array.from({ length: count }, (_, i) => {
    const depth = spread(i, seed + 4); // 0 = far, 1 = near
    // Heavy rain falls longer and straighter; drizzle is short and hangs about.
    const len = 10 + force * 12 + depth * 13;
    const slant = 0.276 - force * 0.06;
    const x = (spread(i, seed) * 400 - 20).toFixed(0);
    return (
      <path
        key={i}
        d={`M${x} 0 l${(len * slant).toFixed(1)} ${(len * 0.961).toFixed(1)}`}
        stroke="url(#wx-drop)"
        strokeWidth={(0.9 + force * 0.4 + depth * 0.9).toFixed(2)}
        strokeLinecap="round"
        opacity={(0.34 + force * 0.12 + depth * 0.4).toFixed(2)}
        style={{
          animationDelay: `-${(spread(i, seed + 1) * 4).toFixed(2)}s`,
          animationDuration: `${(1.55 - force * 0.7 - depth * 0.45).toFixed(2)}s`,
        }}
      />
    );
  });
}

function flakes(count: number, seed: number, force: number) {
  return Array.from({ length: count }, (_, i) => {
    const depth = spread(i, seed + 4);
    return (
      // Two nested groups because a single element cannot run two transform animations, and a
      // flake needs both: the outer one falls, the inner one sways. The horizontal POSITION is
      // the circle's own `cx` rather than a third transform.
      <g
        key={i}
        className="wx-flake-fall"
        style={{
          animationDelay: `-${(spread(i, seed + 1) * 12).toFixed(2)}s`,
          animationDuration: `${(6.2 - force * 1.9 - depth * 1.9).toFixed(2)}s`,
        }}
      >
        <g
          className="wx-flake-sway"
          style={{
            animationDelay: `-${(spread(i, seed + 3) * 6).toFixed(2)}s`,
            animationDuration: `${(4 + spread(i, seed + 5) * 3).toFixed(2)}s`,
          }}
        >
          <circle
            cx={(spread(i, seed) * 400 - 20).toFixed(0)}
            cy="0"
            r={(1.6 + depth * 2.4).toFixed(2)}
            fill="rgb(158, 176, 205)"
            opacity={(0.4 + depth * 0.4).toFixed(2)}
          />
        </g>
      </g>
    );
  });
}

/** One cloud, as three overlapping soft discs. Gradient-filled, so the edge is soft without a
 * blur filter — and `y` shifts the whole silhouette rather than each disc. */
function cloud(x: number, y: number, scale: number, opacity: number) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
      <ellipse cx="0" cy="0" rx="58" ry="32" fill="url(#wx-cloud)" />
      <ellipse cx="44" cy="8" rx="43" ry="25" fill="url(#wx-cloud)" />
      <ellipse cx="-44" cy="10" rx="40" ry="22" fill="url(#wx-cloud)" />
    </g>
  );
}

/**
 * A sky's worth of cloud, sized to the forecast.
 *
 * Two was the same picture for "partly cloudy" and for "overcast", and both read as almost
 * nothing. Overcast now fills the card; partly cloudy keeps its gaps. The count is what
 * separates them — not opacity, because a dimmer cloud is a fainter cloud rather than a
 * clearer sky.
 */
function clouds(force: number) {
  const count = 2 + Math.round(force * 4); // 2 at partly cloudy, 5-6 at overcast/fog
  return Array.from({ length: count }, (_, i) => (
    <g key={i} className={i % 2 === 0 ? "wx-cloud-back" : "wx-cloud-front"}>
      {cloud(
        30 + spread(i, 7) * 320,
        14 + spread(i, 8) * 130,
        0.7 + spread(i, 9) * 0.7,
        0.55 + force * 0.4,
      )}
    </g>
  ));
}

export function WeatherField({ kind, code }: { kind: SkyKind; code?: number }) {
  const force = (code != null ? INTENSITY[code] : undefined) ?? 0.5;
  return (
    <svg
      className={`wx-field wx-field-${kind}`}
      // A viewBox in card pixels, not an abstract 100x100: a stroke width or a drop length is
      // then the size it says it is, instead of whatever `slice` scales it to on the day.
      viewBox="0 0 360 260"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        {/* Fades in fast and stays lit. The first version reached full strength only 60% down
            the streak, which threw away most of a 13px mark and left the rain barely visible.

            A BLUE-GREY, not white. Measured on a storm card: near-white drops put the lightest
            pixel behind the headline at 1.35:1 against the on-sky ink, which is unreadable
            where a streak crosses a glyph. Dimming the colour buys far more contrast headroom
            than dimming the alpha does — a mid-tone at 45% clears the bar, a white one has to
            drop near 12% to do the same, and 12% is invisible. */}
        <linearGradient id="wx-drop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(158, 176, 205)" stopOpacity="0" />
          <stop offset="22%" stopColor="rgb(158, 176, 205)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(158, 176, 205)" stopOpacity="0.75" />
        </linearGradient>
        <radialGradient id="wx-cloud">
          <stop offset="0%" stopColor="rgb(168, 182, 208)" stopOpacity="0.85" />
          <stop offset="70%" stopColor="rgb(168, 182, 208)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="rgb(150, 165, 192)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="wx-sun">
          <stop offset="0%" stopColor="rgb(255, 213, 126)" stopOpacity="0.85" />
          <stop offset="35%" stopColor="rgb(255, 196, 92)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="rgb(255, 176, 60)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {kind === "clear" && (
        // A sun off the corner, not an icon in the middle: it lights the card rather than
        // sitting on it. The rays turn once a minute — slow enough that it never asks to be
        // watched, present enough that the card is not a flat rectangle.
        <g className="wx-sun" transform="translate(286 22)">
          <g className="wx-sun-rays">
            {Array.from({ length: 12 }, (_, i) => (
              <path
                key={i}
                d="M0 -78 L7 -128 L-7 -128 Z"
                fill="rgb(255, 205, 110)"
                opacity="0.13"
                transform={`rotate(${i * 30})`}
              />
            ))}
          </g>
          <circle r="112" fill="url(#wx-sun)" />
        </g>
      )}

      {kind === "cloud" && (
        <>
          {clouds(force)}
        </>
      )}

      {(kind === "rain" || kind === "storm") && (
        <g className="wx-rain">
          {drops(kind === "storm" ? 34 + Math.round(force * 22) : 14 + Math.round(force * 26), 1, force)}
        </g>
      )}

      {kind === "storm" && (
        // A storm has to be more than fast rain — reported as "basically same as rain, can't
        // distinguish", and that was fair: the only difference was drop count. So it gets the
        // one thing rain never has. The flash is the card going pale twice in quick succession,
        // and a bolt rides the same beat: lightning is light first and a shape second, but a
        // shape is what makes it unmistakably a storm rather than a downpour.
        <g className="wx-storm-strike">
          <rect x="0" y="0" width="360" height="260" fill="rgb(198, 214, 246)" opacity="0.42" />
          <path
            d="M300 18 l-26 62 h20 l-16 58 44 -74 h-21 l19 -46 Z"
            fill="rgb(226, 236, 255)"
            opacity="0.85"
          />
        </g>
      )}

      {kind === "snow" && <g className="wx-snow">{flakes(20 + Math.round(force * 22), 2, force)}</g>}
    </svg>
  );
}

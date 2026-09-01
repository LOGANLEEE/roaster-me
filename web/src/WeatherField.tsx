import type { CSSProperties } from "react";
import type { SkyKind } from "./lib/useSky";

/**
 * Falling weather over the card, as discrete streaks.
 *
 * The first attempt translated the card's whole hatched texture instead. It was rejected on
 * sight and the reason is the primitive, not the tuning: a `repeating-linear-gradient` is
 * uniform edge to edge, so moving it slides a corduroy pattern across the card. Rain does not
 * read as an even field. It reads as SPARSE, separate streaks of different lengths falling at
 * different speeds, with gaps between them.
 *
 * So: a handful of absolutely-positioned marks, each with its own offset, length, opacity and
 * duration. Every one animates `transform` and `opacity` only — no layout, no background.
 *
 * The static hatch underneath (tokens.css `.sky[data-sky]::before`) stays exactly as it was.
 * It is the texture at a glance, and it is what reduced-motion users keep: this component
 * renders nothing at all when the field is not moving, rather than leaving frozen dashes
 * scattered over the card.
 */

/** Marks per kind. Enough to read as weather, few enough to stay cheap — each one is a
 * composited node running a transform. A storm is not a different texture, it is more rain. */
const COUNT: Partial<Record<SkyKind, number>> = { rain: 18, storm: 26, snow: 20 };

/**
 * Deterministic pseudo-random in [0, 1) from the mark's index.
 *
 * Deterministic on purpose: `Math.random()` would reshuffle every mark on every re-render, and
 * this card re-renders whenever the day changes or a forecast lands, so the rain would visibly
 * jump. A hash of the index gives the same scatter forever.
 */
function spread(index: number, salt: number): number {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function WeatherField({ kind }: { kind: SkyKind }) {
  const count = COUNT[kind];
  if (!count) return null; // clear and cloud have nothing falling

  const snow = kind === "snow";
  const marks = Array.from({ length: count }, (_, i) => {
    const left = spread(i, 1) * 100;
    const delay = spread(i, 2);
    const speed = spread(i, 3);
    // Depth: a shorter, fainter, slower mark reads as further away.
    const scale = 0.6 + spread(i, 4) * 0.4;
    const duration = snow ? 4.2 + speed * 3.4 : (kind === "storm" ? 0.42 : 0.68) + speed * 0.45;

    return (
      <span
        key={i}
        style={
          {
            left: `${left.toFixed(2)}%`,
            animationDelay: `${(delay * duration).toFixed(2)}s`,
            animationDuration: `${duration.toFixed(2)}s`,
            opacity: (snow ? 0.3 : 0.22) + scale * (snow ? 0.35 : 0.4),
            // Snow drifts sideways as it falls; rain does not.
            "--wx-drift": snow ? `${(spread(i, 5) * 26 - 13).toFixed(1)}px` : "0px",
            "--wx-scale": scale.toFixed(2),
          } as CSSProperties
        }
      />
    );
  });

  return (
    <div className={`wx-field wx-field-${kind}`} aria-hidden="true">
      {marks}
    </div>
  );
}

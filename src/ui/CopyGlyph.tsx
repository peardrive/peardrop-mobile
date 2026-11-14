import React from "react";
import Svg, { Path } from "react-native-svg";

/**
 * The copy mark and its "done" tick, drawn from Pearkit's icon set (`copy` and `tick` in
 * `pearkit/src/icons/registry.ts`): a 24-point box, 1.5 stroke, round ends, no fill. Pearkit's
 * icons are a web set, so the two shapes are repeated here for the phone rather than imported.
 * If the Pearkit drawing changes, change these to match.
 */
const COPY_BACK =
  "M16 12.9V17.1C16 20.6 14.6 22 11.1 22H6.9C3.4 22 2 20.6 2 17.1V12.9C2 9.4 3.4 8 6.9 8H11.1C14.6 8 16 9.4 16 12.9Z";
const COPY_FRONT =
  "M22 6.9V11.1C22 14.6 20.6 16 17.1 16H16V12.9C16 9.4 14.6 8 11.1 8H8V6.9C8 3.4 9.4 2 12.9 2H17.1C20.6 2 22 3.4 22 6.9Z";
const TICK = "M5 12.5L9.5 17L19 7.5";

export type CopyGlyphProps = {
  size?: number;
  color: string;
  /** Show the tick instead: the copy has just been made. */
  done?: boolean;
};

export default function CopyGlyph({ size = 20, color, done = false }: CopyGlyphProps) {
  const stroke = {
    stroke: color,
    strokeWidth: done ? 2 : 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {done ? (
        <Path d={TICK} {...stroke} />
      ) : (
        <>
          <Path d={COPY_BACK} {...stroke} />
          <Path d={COPY_FRONT} {...stroke} />
        </>
      )}
    </Svg>
  );
}

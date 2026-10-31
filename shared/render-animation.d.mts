export type AnimationDefinition = {
  effect?: "static" | "move" | "pulse" | "wave" | "frames";
  direction?: "left" | "right" | "up" | "down";
  speed?: number;
  loop?: boolean;
  hueShift?: number;
  colorOverride?: string;
  brightness?: number;
  frames?: readonly { colors: readonly string[]; duration: number }[];
};

export function scaleColor(hex: string, scale: number): string;

export function applyHueShift(colors: readonly string[], degrees?: number): string[];

export function applyArtworkAppearance(colors: readonly string[], animation?: AnimationDefinition): string[];

export function renderAnimation(
  colors: readonly string[],
  animation: AnimationDefinition,
  elapsed: number,
  keyboardLayout?: readonly { index: number; x: number; y: number; w: number }[],
): string[];

export function animationDuration(animation: AnimationDefinition): number;

import type { CSSProperties } from "react";
export function rangeStyle(value: number, min = 0, max = 100, color = "#202020"): CSSProperties {
  const progress = Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  return { background: `linear-gradient(to right, ${color} 0%, ${color} ${progress}%, #dedede ${progress}%, #dedede 100%)` };
}

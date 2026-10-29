import { t as tr, language } from "./i18n";
import type { CSSProperties } from "react";
import type { Key } from "./types";
export function lightingPeak(frames: readonly (readonly string[])[]) {
  let peak = 1;
  for (const frame of frames) for (const color of frame)
    for (const start of [1, 3, 5]) peak = Math.max(peak, parseInt(color.slice(start, start + 2), 16) || 0);
  return peak;
}
export function Keyboard({
  layout,
  colors,
  selected = [],
  mini = false,
  onKey,
  onGameKey,
  onStrokeStart,
  sideColor,
}: {
  layout: Key[];
  colors: string[];
  selected?: number[];
  mini?: boolean;
  lightPreview?: boolean;
  lightPreviewPeak?: number;
  onKey?: (index: number) => void;
  onGameKey?: (index: number) => void;
  onStrokeStart?: () => void;
  sideColor?: string;
}) {
  const kick = layout.length === 80;
  const width = Math.max(kick ? 16.32 : 16, ...layout.map((k) => k.x + k.w));
  const height = Math.max(6, ...layout.map((k) => k.y + k.h));
  const sideStyle: CSSProperties = {
    top: `${(0.05 / height) * 100}%`,
    height: `${(0.9 / height) * 100}%`,
    ...(sideColor ? { backgroundColor: sideColor } : {}),
  };
  const colorAt = (i: number) => colors[i] || "#000000";
  const positionStyle = (
    key: Pick<Key, "x" | "y" | "w" | "h">,
  ): CSSProperties => ({
    left: `${(key.x / width) * 100}%`,
    top: `${(key.y / height) * 100}%`,
    width: `${(key.w / width) * 100}%`,
    height: `${(key.h / height) * 100}%`,
  });
  const keyStyle = (key: Key): CSSProperties => {
    const color = colorAt(key.index),
      lit = color !== "#000000" && color !== "#000";
    const rgb = color.replace("#", "");
    const lum =
      parseInt(rgb.slice(0, 2), 16) * 0.299 +
      parseInt(rgb.slice(2, 4), 16) * 0.587 +
      parseInt(rgb.slice(4, 6), 16) * 0.114;
    // Display the exact RGB frame; do not blend white into low-intensity colors.
    const face = lit ? color : "#f7f7f6";
    return {
      ...positionStyle(key),
      "--key-color": face,
      "--key-text": lit && lum < 128 ? "#ffffff" : "#292a28",
    } as CSSProperties;
  };
  return (
    <div className={`keyboard-case ${kick ? "kick75" : "air75-v3"} ${mini ? "mini" : ""}`}
      style={kick && sideColor ? {borderColor: sideColor, boxShadow: `inset 0 0 0 2px ${sideColor}`} : undefined}>
      <div
        className="keyboard-matrix"
        style={{ aspectRatio: `${width}/${height}` }}
        onPointerDown={(event) => {
          if ((onKey || onGameKey) && event.button === 0) {
            event.preventDefault();
            const el = (event.target as HTMLElement).closest<HTMLElement>(
              "[data-led]",
            );
            if (el) {
              if (onGameKey) onGameKey(Number(el.dataset.led));
              else {
                onStrokeStart?.();
                onKey?.(Number(el.dataset.led));
              }
            }
          }
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1 && onKey) {
            const el = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest<HTMLElement>("[data-led]");
            if (el && event.currentTarget.contains(el))
              onKey(Number(el.dataset.led));
          }
        }}
      >
        {!kick && <div
          className={`side-led left ${sideColor ? "on" : ""}`}
          style={sideStyle}
        />}
        {tr(layout.map((key) =>
          mini ? (
            <div key={key.index} className="key" style={keyStyle(key)}>
              <span />
            </div>
          ) : (
            <button
              tabIndex={0}
              key={key.index}
              data-led={key.index}
              className={`key ${selected.includes(key.index) ? "selected" : ""}`}
              style={keyStyle(key)}
              aria-label={tr(`${tr(key.label)} ${colorAt(key.index)}`)}
              title={tr(`${tr(key.label)} · ${colorAt(key.index).toUpperCase()}`)}
              onKeyDown={(event) => {
                if (onGameKey && event.key === "Enter" && !event.repeat) {
                  event.preventDefault();
                  onGameKey(key.index);
                } else if (
                  onKey &&
                  (event.key === " " || event.key === "Enter")
                ) {
                  event.preventDefault();
                  onStrokeStart?.();
                  onKey(key.index);
                }
              }}
            >
              <span>{key.code === "PrintScreen" && language() === "en" ? "PrtSc" : tr(key.label)}</span>
            </button>
          ),
        ))}
        <div
          className={`key fixed-keycap ${kick ? "rotary-knob" : ""}`}
          style={positionStyle({ x: kick ? 15.32 : 15, y: 0, w: 1, h: 1 })}
          role="img"
          aria-label={tr(kick ? "旋钮" : "Del 键帽")}
        >
          <span>{tr(mini ? "" : kick ? "旋钮" : "Del")}</span>
        </div>
        {!kick && <div
          className={`side-led right ${sideColor ? "on" : ""}`}
          style={sideStyle}
        />}
      </div>
    </div>
  );
}

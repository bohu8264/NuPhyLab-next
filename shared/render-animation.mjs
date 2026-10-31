import { layout, blank, hsv } from "./layout.mjs";
import { hexToHsv, hsvToHex } from "./color.mjs";

export function scaleColor(hex, scale) {
  return (
    "#" +
    [1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(hex.slice(i, i + 2), 16) * Math.max(0, Math.min(1, scale)),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
/** Rotate rendered artwork colors without changing its stored palette or timing. */
export function applyHueShift(colors, degrees = 0) {
  if (!Number.isFinite(degrees) || degrees < -180 || degrees > 180)
    throw new RangeError("色相偏移应在 -180–180 度之间");
  // Legacy output must retain its original bytes, including HEX letter case.
  if (degrees === 0) return [...colors];
  return colors.map(color => {
    const hsv = hexToHsv(color);
    // Achromatic colors have no hue to rotate; preserve their bytes as well.
    return hsv.s === 0 ? color : hsvToHex({ ...hsv, h: hsv.h + degrees });
  });
}

function artworkColor(animation) {
  const value = animation.colorOverride;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^#[a-f0-9]{6}$/i.test(value))
    throw new RangeError("整体颜色必须是有效的 RGB 颜色");
  return value.toLowerCase();
}

function colorArtwork(colors, color) {
  return colors.map(value => value.toLowerCase() === "#000000" ? value : color);
}

/** Apply saved artwork appearance to a still image, leaving source frames intact. */
export function applyArtworkAppearance(colors, animation = {}) {
  const brightness = animation.brightness === undefined ? 100 : animation.brightness;
  if (!Number.isFinite(brightness) || brightness < 0 || brightness > 100)
    throw new RangeError("作品亮度应在 0–100 之间");
  const color = artworkColor(animation);
  const shifted = color === undefined ? applyHueShift(colors, animation.hueShift) : colorArtwork(colors, color);
  // Avoid a HEX round-trip for legacy/100% output, preserving letter case too.
  return brightness === 100 ? shifted : shifted.map(color => scaleColor(color, brightness / 100));
}

export function renderAnimation(colors, animation, elapsed, keyboardLayout = layout) {
  const color = artworkColor(animation);
  if (color === undefined) {
    const output = renderUnshiftedAnimation(colors, animation, elapsed, keyboardLayout);
    return applyArtworkAppearance(output, animation);
  }
  // Colour the source before the effect. Replacing rendered RGB afterwards
  // would erase a breathing envelope and turn the animation into a still.
  const source = colorArtwork(colors, color);
  const output = renderUnshiftedAnimation(source, animation, elapsed, keyboardLayout, color);
  return applyArtworkAppearance(output, {...animation, colorOverride: undefined, hueShift: 0});
}

function renderUnshiftedAnimation(colors, animation, elapsed, keyboardLayout = layout, color) {
  const speed = animation.speed ?? 4,
    t = elapsed / 1000,
    effect = animation.effect ?? "static";
  if (effect === "static") return [...colors];
  if (effect === "frames") {
    const frames = animation.frames ?? [];
    if (!frames.length) return [...colors];
    const duration = frames.reduce((n, f) => n + f.duration, 0);
    // Stored frame durations describe speed 4. Keep the saved frames intact and
    // apply the same playback rate here and in animationDuration.
    const position = Math.max(0, elapsed) * (speed / 4);
    let at = animation.loop
      ? position % duration
      : Math.min(position, duration);
    for (const f of frames) {
      if (at < f.duration) return color === undefined ? [...f.colors] : colorArtwork(f.colors, color);
      at -= f.duration;
    }
    return color === undefined ? [...frames.at(-1).colors] : colorArtwork(frames.at(-1).colors, color);
  }
  if (effect === "pulse") {
    const power = 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(t * speed * 0.9));
    return colors.map((c) => scaleColor(c, power));
  }
  if (effect === "wave") {
    const output = blank();
    for (const k of keyboardLayout) {
      const phase = (((k.x / 18 - t * speed * 0.035 + k.y * 0.055) % 1) + 1) % 1;
      if (color === undefined) output[k.index] = hsv(phase);
      else if (colors[k.index]?.toLowerCase() !== "#000000")
        output[k.index] = scaleColor(color, 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI)));
    }
    return output;
  }
  if (effect === "move") {
    const output = blank(),
      vertical = ["up", "down"].includes(animation.direction),
      extent = vertical ? 6 : 17;
    const step = Math.floor(t * speed),
      delta = (["left", "up"].includes(animation.direction) ? -1 : 1) * step;
    for (const source of keyboardLayout) {
      if (colors[source.index] === "#000000") continue;
      let pos = (vertical ? source.y : source.x + source.w / 2) + delta;
      if (animation.loop) pos = ((pos % extent) + extent) % extent;
      if (pos < 0 || pos >= extent) continue;
      const candidates = keyboardLayout.filter((k) =>
        vertical
          ? Math.abs(k.x + k.w / 2 - (source.x + source.w / 2)) < 0.7
          : k.y === source.y,
      );
      let best = null,
        distance = Infinity;
      for (const k of candidates) {
        const d = Math.abs((vertical ? k.y : k.x + k.w / 2) - pos);
        if (d < distance) {
          best = k;
          distance = d;
        }
      }
      if (best && distance < 0.7) output[best.index] = colors[source.index];
    }
    return output;
  }
  return [...colors];
}
export function animationDuration(a) {
  if (a.loop || a.effect === "static") return Infinity;
  if (a.effect === "frames")
    return (
      (a.frames ?? []).reduce((n, f) => n + f.duration, 0) /
      ((a.speed ?? 4) / 4)
    );
  if (a.effect === "move")
    return (
      ((["up", "down"].includes(a.direction) ? 6 : 17) / (a.speed || 4)) * 1000
    );
  return ((2 * Math.PI) / ((a.speed || 4) * 0.9)) * 1000;
}

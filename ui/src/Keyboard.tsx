import { t as tr, language } from './i18n';
import { createContext, useContext, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { keyboardGeometry, keyboardInteractiveMinWidth, layoutMatchesGeometry } from './keyboard-geometry';
import type { KeyboardGeometry, KeyboardLayoutKey, KeyboardModelId, KeyRect } from './keyboard-geometry';
import './keyboard-models.css';

export type AirTopRightModule = 'rotary' | 'keycap';
export const KeyboardModuleContext = createContext<AirTopRightModule>('rotary');
export function lightingPeak(frames: readonly (readonly string[])[]) {
  let peak = 1;
  for (const frame of frames) for (const color of frame)
    for (const start of [1, 3, 5]) peak = Math.max(peak, parseInt(color.slice(start, start + 2), 16) || 0);
  return peak;
}
export type KeyboardProps = {
  modelId: KeyboardModelId;
  layout: readonly KeyboardLayoutKey[];
  geometry?: KeyboardGeometry;
  colors: readonly string[];
  selected?: readonly number[];
  mini?: boolean;
  lightPreview?: boolean;
  lightPreviewPeak?: number;
  onKey?: (index: number) => void;
  onGameKey?: (index: number) => void;
  onStrokeStart?: () => void;
  sideColor?: string;
  airTopRightModule?: AirTopRightModule;
};
export function Keyboard({ modelId, layout, geometry = keyboardGeometry[modelId], colors, selected = [], mini = false, lightPreview = false,
  onKey, onGameKey, onStrokeStart, sideColor, airTopRightModule }: KeyboardProps) {
  const preference = useContext(KeyboardModuleContext);
  const stroke = useRef<{pointerId: number; modelId: string; last: number | null} | null>(null);
  const module = airTopRightModule || preference;
  const interactive = !mini && Boolean(onKey || onGameKey);
  if (!geometry || !layoutMatchesGeometry(modelId, layout, geometry)) {
    return <div className="keyboard-layout-unavailable" role="status">{language() === 'en' ? 'Keyboard layout unavailable' : '键盘布局暂不可用'}</div>;
  }
  const { width, height, family } = geometry;
  const colorAt = (index: number) => colors[index] || '#000000';
  // NODE's left apertures display the side-light group; they are not individually addressable.
  const indicatorColor = sideColor && !/^#0{3}(0{3})?$/i.test(sideColor) ? sideColor : '#CBCBCB';
  const positionStyle = ({x, y, w, h}: KeyRect): CSSProperties => ({
    left: `${x / width * 100}%`, top: `${y / height * 100}%`, width: `${w / width * 100}%`, height: `${h / height * 100}%`,
  });
  const keyStyle = (key: KeyboardLayoutKey): CSSProperties => {
    const color = colorAt(key.index);
    // In a light show, an off LED is black. The paint canvas uses a pale
    // unpainted key so its legend stays visible while editing.
    const showLEDColor = lightPreview || !/^#0{3}(0{3})?$/i.test(color);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) || 0);
    return {...positionStyle(geometry.keys[key.index]), '--key-color': showLEDColor ? color : '#FCFCFC',
      '--key-text': showLEDColor && r * .299 + g * .587 + b * .114 < 128 ? '#ffffff' : '#747474'} as CSSProperties;
  };
  const englishLabels: Record<string, string> = {
    PrintScreen: 'PrtSc', LockScreen: 'Lock', ShowDesktop: 'Desk', ControlCenter: 'Ctrl Ctr', TaskManager: 'Task',
  };
  const label = (key: KeyboardLayoutKey) => language() === 'en' && englishLabels[key.code] ? englishLabels[key.code]
    : key.label === '⌘' ? 'Cmd' : key.label === '⌫' ? 'Back' : tr(key.label);
  const accessibleLabel = (key: KeyboardLayoutKey) => `${label(key) || 'Space'}${key.code.startsWith('Numpad') ? (language() === 'en' ? ' numpad' : ' 数字区') : ''} ${colorAt(key.index)}`;
  const activate = (index: number) => {
    if (onGameKey) onGameKey(index);
    else { onStrokeStart?.(); onKey?.(index); }
  };
  const hit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-led]');
    return el && event.currentTarget.contains(el) ? Number(el.dataset.led) : null;
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (stroke.current?.pointerId !== event.pointerId) return;
    stroke.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`keyboard-case v5-keyboard model-keyboard ${modelId} family-${family} ${mini ? 'mini' : ''}`}
    data-model={modelId} data-module={family === 'node' ? 'touch-strip' : family === 'kick' ? 'rotary' : module}
    style={{'--model-key-font': `${1553.58 / width}cqw`, '--model-key-radius': `${600 / width}cqw`,
      '--model-min-width': `${keyboardInteractiveMinWidth(modelId, geometry)}px`} as CSSProperties}>
    <div className="keyboard-matrix" style={{aspectRatio: `${width}/${height}`}} role="group" aria-label={`${geometry.title} ANSI`}
      onPointerDown={event => {
        if (!interactive || event.button !== 0 || !event.isPrimary) return;
        const index = hit(event);
        if (index === null) return;
        event.preventDefault();
        stroke.current = {pointerId: event.pointerId, modelId, last: index};
        event.currentTarget.setPointerCapture(event.pointerId);
        activate(index);
      }}
      onPointerMove={event => {
        const current = stroke.current;
        if (!interactive || !onKey || onGameKey || !current || current.pointerId !== event.pointerId || current.modelId !== modelId) return;
        if (!(event.buttons & 1)) { end(event); return; }
        const index = hit(event);
        if (index !== null && index !== current.last) { current.last = index; onKey(index); }
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { stroke.current = null; }}>
      {geometry.topSurface && <svg className="model-node-surface" aria-hidden="true" focusable="false"
        viewBox={`0 0 ${geometry.topSurface.width} ${geometry.topSurface.height}`}
        style={{height: `${geometry.topSurface.height / height * 100}%`}}>
        {geometry.topSurface.dots.map((dot, i) => <circle className="node-surface-dot" key={i}
          cx={dot.cx} cy={dot.cy} r={dot.r} fill="#CBCBCB"/>)}
        {geometry.topSurface.indicators?.map((dot, i) => <circle className="node-indicator-dot" key={`light-${i}`}
          cx={dot.cx} cy={dot.cy} r={dot.r} fill={indicatorColor}/>)}
      </svg>}
      {layout.map(key => interactive
        ? <button type="button" key={key.index} data-led={key.index}
            className={`key ${selected.includes(key.index) ? 'selected' : ''} ${label(key).length > 5 ? 'long-legend' : ''}`} style={keyStyle(key)}
            aria-label={accessibleLabel(key)} aria-pressed={selected.includes(key.index)} title={`${label(key) || 'Space'} · ${colorAt(key.index).toUpperCase()}`}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) activate(key.index); }
            }}
            onClick={event => { if (event.detail === 0) activate(key.index); }}><span>{label(key)}</span></button>
        : <div key={key.index} className={`key ${label(key).length > 5 ? 'long-legend' : ''}`} style={keyStyle(key)} role={mini ? undefined : 'img'}
            aria-label={mini ? undefined : accessibleLabel(key)}><span>{mini ? null : label(key)}</span></div>)}
      {geometry.controls.map(control => {
        if (control.kind === 'side-led') return <div key={control.id} className={`model-side-led ${sideColor ? 'on' : ''}`}
          aria-hidden="true" style={{...positionStyle(control), backgroundColor: sideColor || '#CBCBCB'}}/>;
        if (control.kind === 'touch-strip') return <div key={control.id} className="model-touch-strip" style={positionStyle(control)}
          role="img" aria-label={language() === 'en' ? 'Touch strip' : '触摸条'}/>;
        const knob = control.kind === 'dial' || module === 'rotary';
        return <div key={control.id} className={`key fixed-keycap ${knob ? 'rotary-knob' : 'module-del'}`} style={positionStyle(control)}
          role="img" aria-label={tr(knob ? '旋钮' : 'Del 键帽')}><span>{knob ? <i className="dial-slot"/> : mini ? '' : 'Del'}</span></div>;
      })}
    </div>
  </div>;
}

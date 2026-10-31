import { language } from './i18n';
import type { ConnectionDisplay, ConnectionDisplayCopy } from '../../shared/connection-display.mjs';

export function connectionCopy(value: ConnectionDisplayCopy | null | undefined): string {
  return value ? language() === 'en' ? value.en : value.zh : '';
}

export function presentConnectionDisplay(display: ConnectionDisplay): ConnectionDisplay {
  if (display.reasonId !== 'multipleUsb') return display;
  return {...display,
    header: {zh:'连接需处理 · 多 USB',en:'USB conflict'},
    sidebar: {zh:'暂不可用 · 多 USB',en:'Unavailable · USB conflict'},
    deviceTitle: {zh:'检测到多把 USB 键盘',en:'Multiple USB keyboards detected'},
    deviceBody: {zh:'请只保留要控制的一把 USB 连接，再重新检测。',en:'Keep only the keyboard you want to control connected by USB, then check again.'},
    devicePrimaryCopy: {zh:'重新检测',en:'Check again'},
  };
}

// The approved 01–03 native boards use shorter surface copy than the shared
// state contract. Keep that presentation choice separate from state selection.
export function connectionHeader(display: ConnectionDisplay): string {
  return display.reasonId === 'multipleUsb'
    ? connectionCopy({zh: '连接需处理 · 多 USB', en: 'USB conflict'})
    : connectionCopy(display.header);
}

export function connectionSidebar(display: ConnectionDisplay): string {
  return display.reasonId === 'multipleUsb'
    ? connectionCopy({zh: '暂不可用 · 多 USB', en: 'Unavailable · USB conflict'})
    : connectionCopy(display.sidebar);
}

export function canvasCaption(display: ConnectionDisplay): string {
  const model = display.canvasModelId === 'kick75' ? 'Kick75'
    : display.canvasModelId === 'air75-v3' ? 'Air75 V3' : '';
  if (!model) return '';
  const offline = display.stateId !== 'usbReady';
  return connectionCopy({
    zh: `画布版型: ${model} · ${offline ? '离线编辑' : '当前作品画布'}`,
    en: `Canvas layout: ${model} · ${offline ? 'Offline editing' : 'Artwork canvas'}`,
  });
}

export function keyboardActionHint(display: ConnectionDisplay): string {
  if (display.reasonId === 'multipleUsb') return connectionCopy({
    zh: '多 USB，暂不可播放', en: 'USB conflict; playback unavailable',
  });
  if (display.stateId === 'disconnected') return connectionCopy({
    zh: '连接 USB 后可播放', en: 'USB required for keyboard output',
  });
  if (display.stateId === 'serviceUnknown') return connectionCopy({
    zh: '连接状态未确认', en: 'Connection is not confirmed',
  });
  return display.stateId === 'usbReady' ? '' : connectionCopy(display.workTitle);
}

export function coalescePermissionRefresh(owner: object, refresh: () => Promise<unknown>): Promise<unknown>;
export function watchPermissionRefresh(options: {
  refresh: () => Promise<unknown>;
  isVisible: () => boolean;
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  interval?: number;
}): () => void;

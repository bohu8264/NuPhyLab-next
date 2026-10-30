export function coalescePermissionRefresh(owner: object, refresh: () => Promise<unknown>): Promise<unknown>;
export function refreshPermissionSession(command: (request: {op:string;hostPermissions?:unknown}) => Promise<unknown>, readNative: () => Promise<{available:boolean;result:unknown}>): Promise<unknown>;
export function watchPermissionRefresh(options: {
  refresh: () => Promise<unknown>;
  isVisible: () => boolean;
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  interval?: number;
}): () => void;

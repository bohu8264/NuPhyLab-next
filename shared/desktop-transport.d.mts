export function isTauriDesktop(target?: unknown): boolean;
export function isNativeDesktop(target?: unknown): boolean;
export function usesDesktopKeyRouting(target?: unknown): boolean;
export function nativeDesktopRequest(channel: 'codexKeys'|'audioControl', value: Record<string,unknown>, target?: unknown): Promise<{available:boolean;result:unknown;reason?:string}>;
export function desktopRequest(route: string, body?: Record<string,unknown>, target?: unknown): Promise<any>;

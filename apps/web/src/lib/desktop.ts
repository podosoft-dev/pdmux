export interface DesktopConnectionBridge {
  connect(url: string): Promise<unknown>;
  authenticate(code: string): Promise<unknown>;
  workspace(id: string | null): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
export function desktopConnection(): DesktopConnectionBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pdmuxDesktop?: { connection?: DesktopConnectionBridge } }).pdmuxDesktop?.connection;
}

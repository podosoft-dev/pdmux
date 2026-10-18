/** Bun 1.4 supports upgrade headers; the older shared DOM declarations do not. */
interface AuthenticatedSocketConstructor { new(url: string, options: { headers: Record<string, string> }): WebSocket }
export const AuthenticatedWebSocket = globalThis.WebSocket as unknown as AuthenticatedSocketConstructor;

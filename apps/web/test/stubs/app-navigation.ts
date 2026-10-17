// The admin settings registry imports components that navigate; tests never render them.
export async function goto(): Promise<void> {}
export async function invalidate(): Promise<void> {}
export async function invalidateAll(): Promise<void> {}
export function afterNavigate(): void {}
export function beforeNavigate(): void {}
export function onNavigate(): void {}

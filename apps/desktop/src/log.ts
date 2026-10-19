export function logError(action: string, error: unknown, context: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    action,
    message: error instanceof Error ? error.message : String(error),
    ...context,
  })}\n`);
}

import { parseAnsiLines, type HistoryLine, type TerminalSlot } from "@pdmux/core";
import { terminalApi } from "./api";

/** Both dashboard and detached panes read the selected engine's history. */
export async function readTerminalHistory(
  slot: TerminalSlot,
): Promise<{ lines: HistoryLine[]; scrollback: boolean; screenOnly?: boolean } | null> {
  if (slot.kind === "shell" || !slot.session) return null;
  const { lines, screenOnly } = await terminalApi.history(slot.hostId, slot.session, slot.backend, slot.sessionId);
  // Parsing is a rendering decision; the server preserves the terminal's ANSI.
  const parsed = parseAnsiLines(lines);
  return { lines: parsed, scrollback: parsed.length > 0, screenOnly };
}

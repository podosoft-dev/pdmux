import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import type { ExecResult } from "@pdmux/protocol";
import { AgentExecService } from "../agents/agent-exec.service";
import { AppException } from "../common/app-exception";
import { resolveScopeId } from "../fleet/session-scope";
import { MuxCopyModeDto, MuxHistoryDto } from "./dto/terminal-mux.dto";

/**
 * Reaching a pane's SCROLLBACK, which is not in the browser.
 *
 * REPORTED: a pane running one coding agent scrolls with the wheel and a pane running
 * another does not. Neither is a pdmux bug and neither is fixable in the browser. A
 * `session` pane attaches to `tmux`, so xterm is in its ALTERNATE buffer and keeps no
 * scrollback of its own (`BufferSet.ts` — there is nothing there to scroll). What the
 * wheel does from there is entirely the running program's choice: when it turns on
 * mouse tracking, xterm encodes a report and its own scrollback/cursor-key fallback is
 * skipped outright (`Terminal.ts`, `if (requestedEvents.wheel) return`). One program
 * acts on that report by moving its transcript; another ignores it; nothing in between
 * gets a say.
 *
 * The history the user is asking for lives in TMUX, and tmux will hand it over to
 * anyone who asks — from outside the session, without touching the program inside.
 * That is all this controller does.
 *
 * ⚠ NO NEW WIRE CONTRACT. This rides the existing `exec` capability (CONTRACTS §C6):
 * the agent runs a binary with argv it never assembles into a shell command, and
 * answers with an exit code. Adding a terminal frame for it would have meant a
 * protocol version, an agent handler, and a relay path — for a fixed pair of commands
 * the fleet can already run.
 *
 * ⚠ THE PROGRAM INSIDE IS NEVER SENT A KEY. Every alternative considered here ended in
 * typing something into somebody's session: the multiplexer's own prefix (which the
 * operator may have rebound, so the bytes land in the application), or PageUp (which
 * the measured programs do not answer to). Both are the same class of mistake — a
 * scroll gesture that edits a running command line.
 */
@ApiTags("terminal")
@Controller("terminal")
export class TerminalMuxController {
  /** tmux keeps a pane's history in lines, and this is asked for in one exec. */
  private static readonly HISTORY_LINES = 400;

  constructor(private readonly exec: AgentExecService) {}

  @Post(":hostId/copy-mode")
  async copyMode(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: MuxCopyModeDto,
  ): Promise<{ ok: true }> {
    // `-e` leaves copy-mode by itself once the pane is scrolled back to the bottom, so
    // the ordinary way out is the gesture the user was already making. `cancel` is for
    // the button, and is harmless on a pane that already left.
    const args =
      dto.action === "enter"
        ? ["copy-mode", "-e", "-t", dto.session]
        : ["send-keys", "-X", "-t", dto.session, "cancel"];
    await this.run(session, hostId, args);
    return { ok: true };
  }

  @Post(":hostId/history")
  async history(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: MuxHistoryDto,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const result = await this.run(session, hostId, [
      "capture-pane",
      "-p",
      "-S",
      `-${TerminalMuxController.HISTORY_LINES}`,
      "-t",
      dto.session,
    ]);

    /**
     * ⚠ TRUNCATION CUTS THE WRONG END, WHICH IS WHY IT IS HANDLED RATHER THAN REPORTED.
     * The agent clips an over-long result by keeping its FIRST 64 KiB, and the first
     * lines of a capture are the OLDEST — so a wide pane full of long lines would
     * return ancient output and silently drop everything the user actually came back
     * for. One narrower retry costs a round trip and cannot lie; passing `truncated`
     * up and rendering it anyway would have looked like history and not been it.
     */
    if (result.truncated) {
      const narrower = await this.run(session, hostId, [
        "capture-pane",
        "-p",
        "-S",
        `-${Math.floor(TerminalMuxController.HISTORY_LINES / 4)}`,
        "-t",
        dto.session,
      ]);
      return { lines: splitLines(narrower.stdout), truncated: true };
    }
    return { lines: splitLines(result.stdout), truncated: false };
  }

  private async run(session: UserSession, hostId: string, args: string[]): Promise<ExecResult> {
    const result = await this.exec.run(resolveScopeId(session), hostId, {
      command: "tmux",
      args,
      // A multiplexer command is a local ioctl away from instant. Anything slower is a
      // wedged server, and the caller is a button somebody is waiting on.
      timeoutMs: 5_000,
    });

    if (result.code === "COMMAND_NOT_FOUND") {
      /**
       * ⚠ "NOT FOUND" IS ALMOST NEVER "NOT INSTALLED" ON THIS PATH, and saying so cost
       * a round of testing. Reported: the control did nothing on a Mac whose panes were
       * attached to tmux sessions at that very moment — so the binary was plainly there.
       * The agent spawns a pane's tmux through `sys.ResolveBinary`, which also searches
       * the places a service manager's PATH omits (`/opt/homebrew/bin`, a user's own
       * prefixes); `exec` used to consult PATH alone, so the SAME agent could run tmux
       * for a terminal and not find it for a command. That is fixed in the agent, which
       * means the actionable half of this message is the agent version, not tmux.
       */
      throw new AppException(
        "MUX_NOT_FOUND",
        "The agent could not find tmux on this host. Older agents only search PATH, which a service manager trims — update the agent from the dashboard.",
        409,
      );
    }
    if (result.exitCode !== 0) {
      // tmux says "can't find pane: x" and similar on stderr; that names the actual
      // problem far better than any sentence written here could.
      throw new AppException(
        "MUX_COMMAND_FAILED",
        result.stderr.trim() || "The multiplexer refused the command",
        409,
      );
    }
    return result;
  }
}

/** tmux pads every captured line to the pane width; the tail is unused buffer. */
function splitLines(stdout: string): string[] {
  const lines = stdout.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

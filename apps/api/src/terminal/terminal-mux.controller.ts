import type { ExecResult } from "@pdmux/protocol";
import { AgentExecService } from "../agents/agent-exec.service";
import type { AuthSession } from "../auth/auth.service";
import { AppException } from "../common/app-exception";
import { resolveScopeId } from "../fleet/session-scope";
import { MuxCopyModeDto, MuxHistoryDto, MuxRenameDto, MuxSessionDto } from "./dto/terminal-mux.dto";
import { AgentRegistryService } from "../agents/agent-registry.service";
import { HostsService } from "../hosts/hosts.service";
import { randomUUID } from "node:crypto";
import type { SessionRenamedEvent } from "./session-renames";

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
 * The tmux adapter rides the existing `exec` capability (CONTRACTS §C6):
 * the agent runs a binary with argv it never assembles into a shell command, and
 * answers with an exit code. Adding a terminal frame for it would have meant a
 * protocol version, an agent handler, and a relay path. Native sessions instead
 * use negotiated session-control frames and UUIDs; they never execute tmux.
 *
 * ⚠ THE PROGRAM INSIDE IS NEVER SENT A KEY. Every alternative considered here ended in
 * typing something into somebody's session: the multiplexer's own prefix (which the
 * operator may have rebound, so the bytes land in the application), or PageUp (which
 * the measured programs do not answer to). Both are the same class of mistake — a
 * scroll gesture that edits a running command line.
 */
export class TerminalMuxController {
  /**
   * How much history to walk back through, and in what bites.
   *
   * ⚠ ONE BIG REQUEST CANNOT WORK, AND THE FIRST VERSION OF THIS PROVED IT. `exec`
   * carries 64 KiB, the agent clips an over-long result by keeping its FIRST bytes, and
   * the first lines of a capture are the OLDEST — so a wide pane returned ancient
   * output and dropped everything the reader came back for. The retry that guarded
   * against it dropped to a quarter of the lines, which is why the sheet was reported
   * as far too short: 400 lines of a 160-column pane trips the cap, so what people
   * actually saw was 100 lines.
   *
   * So the capture is walked in WINDOWS, newest first. Each window is small enough to
   * arrive whole, and stopping early therefore loses the OLD end — the harmless one.
   */
  private static readonly WINDOW_LINES = 200;
  /** tmux's own `history-limit` defaults to 2000; asking past what it holds is free. */
  private static readonly MAX_LINES = 5_000;
  /** A ceiling on round trips, so a pathological pane cannot hold the request open. */
  private static readonly MAX_WINDOWS = 40;

  constructor(
    private readonly exec: AgentExecService,
    private readonly registry?: AgentRegistryService,
    private readonly hosts?: HostsService,
    /** Told about each tmux rename, so other windows on the session can follow it (`SessionRenames`). */
    private readonly renamed?: (event: SessionRenamedEvent) => void,
  ) {}

  async rename(session: AuthSession, hostId: string, dto: MuxRenameDto): Promise<{ name: string; sessionId?: string; tmuxId?: string }> {
    if (dto.backend === "tmux") {
      const id = this.tmuxId(dto.tmuxId);
      const current = await this.run(session, hostId, ["list-sessions", "-F", "#{session_id}|#{session_name}"]);
      let from: string | undefined;
      for (const line of current.stdout.split("\n")) {
        const at = line.indexOf("|");
        if (at <= 0) continue;
        if (line.slice(0, at) === id) from = line.slice(at + 1);
        else if (line.slice(at + 1) === dto.name) throw new AppException("SESSION_EXISTS", "A tmux session already has that name", 409);
      }
      await this.run(session, hostId, ["rename-session", "-t", id, "--", dto.name]);
      if (from && from !== dto.name) this.renamed?.({ type: "host.session-renamed", hostId, tmuxId: id, from, to: dto.name });
      this.registry?.sendToHost(hostId, { type: "collect", what: "heartbeat" });
      return { name: dto.name, tmuxId: id };
    }
    const result = await this.nativeAction(session, hostId, dto, "rename", dto.name);
    if (result.name !== dto.name) throw new AppException("SESSION_ENGINE_UPDATE_REQUIRED", "Update the session engine to rename sessions", 409);
    // Refresh the shared session list through the ordinary heartbeat path.
    this.registry?.sendToHost(hostId, { type: "collect", what: "heartbeat" });
    return { name: result.name, sessionId: dto.sessionId };
  }

  async terminate(session: AuthSession, hostId: string, dto: MuxSessionDto): Promise<{ ok: true }> {
    if (dto.backend === "tmux") await this.run(session, hostId, ["kill-session", "-t", this.tmuxId(dto.tmuxId)]);
    else await this.nativeAction(session, hostId, dto, "terminate");
    this.registry?.sendToHost(hostId, { type: "collect", what: "heartbeat" });
    return { ok: true };
  }

  private tmuxId(id: string | undefined): string {
    if (!id || !/^\$[0-9]{1,16}$/.test(id)) throw new AppException("SESSION_RENAME_UNSUPPORTED", "Update the host agent to manage tmux sessions by ID", 409);
    return id;
  }

  private async nativeAction(
    session: AuthSession, hostId: string, dto: Pick<MuxHistoryDto, "backend" | "sessionId">, action: "history" | "terminate" | "rename", name?: string,
  ): Promise<{ lines: string[]; screenOnly: boolean; name?: string }> {
    if (!this.hosts || !this.registry || !dto.sessionId || dto.backend !== "native") {
      throw new AppException("NATIVE_SESSIONS_UNSUPPORTED", "Native sessions are unavailable", 409);
    }
    const host = await this.hosts.get(resolveScopeId(session), hostId);
    if (!host.enabled) throw new AppException("HOST_DISABLED", "This host is disabled", 409);
    const registry = this.registry;
    const ability = registry.terminalAbility(hostId);
    if (!ability.nativeSessions || ability.screenProtocol !== 1) {
      throw new AppException("NATIVE_SESSIONS_UNSUPPORTED", "Update the host agent to use native sessions", 409);
    }
    if (action === "rename" && !ability.renameSessions) {
      throw new AppException("SESSION_RENAME_UNSUPPORTED", "Update the host agent to rename sessions", 409);
    }
    const sessionId = dto.sessionId;
    const termId = `control-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new AppException("SESSION_TIMEOUT", "The session engine did not answer", 504));
      }, 5_000);
      const off = registry.onTerminalFrame((source, frame) => {
        if (source !== hostId || frame.termId !== termId || frame.type !== "session-result") return;
        clearTimeout(timer);
        off();
        if (frame.error) reject(new AppException(frame.error, "The session operation failed", 409));
        else resolve({ lines: frame.lines, screenOnly: frame.screenOnly, ...(frame.name ? { name: frame.name } : {}) });
      });
      if (!registry.sendToHost(hostId, { type: "terminal", frame: { type: "session-control", termId, action, sessionId, ...(name ? { name } : {}) } })) {
        clearTimeout(timer);
        off();
        reject(new AppException("HOST_OFFLINE", "The host is offline", 409));
      }
    });
  }

  async copyMode(
    session: AuthSession,
    hostId: string,
    dto: MuxCopyModeDto,
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

  async history(
    session: AuthSession,
    hostId: string,
    dto: MuxHistoryDto,
  ): Promise<{ lines: string[]; reachedOldest: boolean; screenOnly: boolean }> {
    if (dto.backend === "native") {
      const result = await this.nativeAction(session, hostId, dto, "history");
      return { ...result, reachedOldest: true };
    }
    const { WINDOW_LINES, MAX_LINES, MAX_WINDOWS } = TerminalMuxController;
    /** Newest-first while gathering; reversed once, at the end. */
    const chunks: string[][] = [];
    let lines = 0;
    let end = 0; // lines above the visible screen; 0 is the screen itself
    let reachedOldest = false;
    const pane = await this.paneFacts(session, hostId, dto.session);

    for (let window = 0; window < MAX_WINDOWS && lines < MAX_LINES; window += 1) {
      let span = Math.min(WINDOW_LINES, MAX_LINES - lines);
      let captured: string[] | null = null;

      // A window that still arrives clipped is halved rather than abandoned: one pane
      // full of very long lines should cost extra round trips, not lose its colour.
      for (let attempt = 0; attempt < 4 && span >= 1; attempt += 1) {
        const result = await this.run(session, hostId, this.captureArgs(dto.session, end + span, end));
        if (!result.truncated) {
          captured = splitLines(result.stdout);
          break;
        }
        span = Math.floor(span / 2);
      }
      if (captured === null) break;

      // Nothing left up there, whatever the pane claims to hold.
      if (captured.length === 0) {
        reachedOldest = true;
        break;
      }
      /**
       * ⚠ A WINDOW ASKED FOR PAST THE TOP COMES BACK AS THE VISIBLE SCREEN, NOT AS NOTHING.
       *
       * Measured (tmux 3.7b, isolated 80x24 pane, `history_size` 379, 2026-08-17): every one of
       * `-S -400 -E -300`, `-S -600 -E -400`, `-S -800 -E -600` and `-S -2000 -E -1800` returned
       * the same 24 rows — the newest lines, the ones already in the first window. Within the
       * history the same tmux pages exactly as documented (`-S -200 -E -100` returned lines 178
       * to 278), so this is the boundary behaving oddly rather than `-E` being broken.
       *
       * It matters because `captured.length < span` no longer stops the walk: 24 rows used to be
       * read as "the top", which is right by accident. Now the walk would ask forty times and the
       * sheet would carry forty copies of one screen. `reachedOldest` is true — a window that
       * runs past the top is exactly how a walk learns there is nothing above it.
       */
      const newest = chunks[0];
      if (newest && repeatsTail(newest, captured)) {
        reachedOldest = true;
        break;
      }

      chunks.push(captured);
      lines += captured.length;
      end += span;
      /**
       * ⚠ THE OLD STOP CONDITION WAS `captured.length < span`, AND `-J` MADE IT WRONG. Joining
       * wrapped rows is the whole point of `-J` (a 3,000-character command is twenty-five rows
       * of a 120-column pane), so a full window legitimately comes back as FEWER lines than the
       * rows asked for — measured in an isolated session, 210 rows of wrapped output arrived as
       * 54 joined lines, which the old test read as "the top of the history" and stopped at the
       * first window. `MAX_LINES` was unreachable by construction.
       *
       * tmux itself knows how much it holds, so ask it instead of inferring: `#{history_size}`
       * counts exactly the lines above the visible screen, which is what `end` walks through.
       */
      if (end >= pane.historySize) {
        reachedOldest = true;
        break;
      }
    }

    return { lines: chunks.reverse().flat(), reachedOldest, screenOnly: pane.alternate };
  }

  /**
   * What the pane can be asked for, in one round trip.
   *
   * ⚠ `#{alternate_on}` IS THE DIFFERENCE BETWEEN A SHORT HISTORY AND NO HISTORY, and only the
   * host can answer it. A full-screen program (a coding agent's TUI, `vim`) draws on the pane's
   * ALTERNATE screen, and tmux keeps history for the normal one — so a capture returns that
   * program's current screenful and nothing before it. Measured on two hosts in one fleet on
   * 2026-08-17: one pane `alternate_on 1` with `history_size` 48, the other `alternate_on 0`
   * with 1991. The sheet shows both, so it has to be able to say which it is holding; calling
   * the first one a history is a claim the reader cannot check.
   *
   * A pane that cannot be measured is not an error — the capture below is still worth trying,
   * and the caller degrades to the budget it already has.
   */
  private async paneFacts(
    session: AuthSession,
    hostId: string,
    target: string,
  ): Promise<{ historySize: number; alternate: boolean }> {
    const args = ["display-message", "-p", "-t", target, "#{history_size} #{alternate_on}"];
    const result = await this.run(session, hostId, args);
    const [size, alternate] = result.stdout.trim().split(/\s+/);
    const parsed = Number.parseInt(size ?? "", 10);
    return {
      historySize: Number.isFinite(parsed) && parsed >= 0 ? parsed : TerminalMuxController.MAX_LINES,
      alternate: alternate === "1",
    };
  }

  /**
   * One window of a capture, addressed from the END of the history backwards.
   *
   * `-S`/`-E` count lines above the visible screen, so `-S -400 -E -201` is "the 200
   * lines that sit 201-400 back". `-e` is what keeps the colour: without it tmux
   * returns plain text, which is why the sheet was grey.
   */
  private captureArgs(session: string, start: number, end: number): string[] {
    /**
     * ⚠ `-J` OR THERE IS NOTHING TO FOLD. tmux stores a pane by ROWS, so a 3,000-character
     * command line is already twenty-five 120-column rows by the time it is captured —
     * measured: the longest line of a capture without `-J` was 177 characters, which is
     * the pane width plus its escapes. Rejoining them is what restores the line the user
     * actually typed, and it is the difference between a sheet that reflows to the reader's
     * width and one that carries the pane's width around with it forever.
     */
    const args = ["capture-pane", "-p", "-e", "-J", "-S", `-${start}`];
    // `-E 0` would mean the first line of the visible screen rather than its last, so
    // the newest window asks for no end at all and takes the screen with it.
    if (end > 0) args.push("-E", `-${end}`);
    return [...args, "-t", session];
  }

  private async run(session: AuthSession, hostId: string, args: string[]): Promise<ExecResult> {
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

/**
 * Split a capture into lines and nothing else.
 *
 * ⚠ THE TRIMMING THAT USED TO BE HERE WAS SILENTLY DEAD ONCE `-e` ARRIVED. tmux pads
 * every line to the pane width, but with escapes in the stream a line ends in
 * `ESC[0m` AFTER that padding — so `/\s+$/` matched nothing, every line stayed 80-200
 * columns wide, and the "is this line blank" test never fired either. Only something
 * that has separated text from escapes can answer, so both jobs moved to the parser in
 * `@pdmux/core` (`parseAnsiLines`). This function must stay dumb: a trim here would be
 * a second opinion about bytes it cannot read.
 *
 * The trailing empty element from a final newline goes, and nothing else.
 */
function splitLines(stdout: string): string[] {
  const lines = stdout.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Is `window` just the end of `newest` again?
 *
 * The walk asks for older and older windows, so a window whose every line is already the TAIL of
 * the newest one is not older output — it is the visible screen a second time, which is what tmux
 * answers a window that starts above the oldest line it holds. Comparing the whole run rather
 * than one line matters: a single repeated line is ordinary (a blank line, a repeated prompt), a
 * repeated screenful is not.
 */
function repeatsTail(newest: string[], window: string[]): boolean {
  if (window.length === 0 || window.length > newest.length) return false;
  const offset = newest.length - window.length;
  return window.every((line, index) => line === newest[offset + index]);
}

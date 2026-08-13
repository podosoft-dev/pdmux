import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ExecResult } from "@pdmux/protocol";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import type { UserSession } from "@thallesp/nestjs-better-auth";
import { AgentExecService } from "../agents/agent-exec.service";
import { AppException } from "../common/app-exception";
import { MuxCopyModeDto, MuxHistoryDto } from "./dto/terminal-mux.dto";
import { TerminalMuxController } from "./terminal-mux.controller";

const HOST = "11111111-2222-3333-4444-555555555555";
const SESSION = { user: { id: "u1" }, session: { activeOrganizationId: "org-a" } } as unknown as UserSession;

function ok(stdout = ""): ExecResult {
  return { commandId: "c", exitCode: 0, stdout, stderr: "", truncated: false, timedOut: false, code: null, message: "" };
}

function build(...results: ExecResult[]): {
  controller: TerminalMuxController;
  calls: { organizationId: string; hostId: string; args: string[] }[];
} {
  const calls: { organizationId: string; hostId: string; args: string[] }[] = [];
  const queue = [...results];
  const exec = {
    run: jest.fn(async (organizationId: string, hostId: string, input: { command: string; args?: string[] }) => {
      calls.push({ organizationId, hostId, args: [input.command, ...(input.args ?? [])] });
      return queue.shift() ?? ok();
    }),
  } as unknown as AgentExecService;
  return { controller: new TerminalMuxController(exec), calls };
}

describe("[TC-PDTERM-136] reaching a pane's scrollback without typing into it", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("puts the multiplexer in copy-mode, and takes it back out", async () => {
    await ctx.controller.copyMode(SESSION, HOST, { session: "main", action: "enter" });
    // ⚠ THE ARGV IS THE CONTRACT. `-e` is what lets a scroll to the bottom leave
    // copy-mode on its own, which is the only exit most users will ever perform.
    expect(ctx.calls[0]?.args).toEqual(["tmux", "copy-mode", "-e", "-t", "main"]);
    // Scoped by the session, never by anything the request carried.
    expect(ctx.calls[0]?.organizationId).toBe("org-a");

    await ctx.controller.copyMode(SESSION, HOST, { session: "main", action: "exit" });
    expect(ctx.calls[1]?.args).toEqual(["tmux", "send-keys", "-X", "-t", "main", "cancel"]);
  });

  it("never sends the program a key", async () => {
    await ctx.controller.copyMode(SESSION, HOST, { session: "main", action: "enter" });
    await ctx.controller.history(SESSION, HOST, { session: "main" });
    // `send-keys -X` addresses the COPY-MODE, not the pane's input; every other form of
    // send-keys would type into whatever the user is running. Nothing here may do that.
    for (const call of ctx.calls) {
      const sendKeys = call.args.indexOf("send-keys");
      if (sendKeys >= 0) expect(call.args[sendKeys + 1]).toBe("-X");
    }
  });

  it("[TC-PDTERM-137] walks the history in windows, newest first, and says where it stopped", async () => {
    // Three windows of output and then a short one, which is how tmux answers a request
    // that reaches past its own `history-limit`.
    const full = (mark: string) => ok(Array.from({ length: 200 }, (_, i) => `${mark}${i}`).join("\n") + "\n");
    ctx = build(full("c"), full("b"), ok("a0\na1\n"));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    // ⚠ `-e` IS THE COLOUR and `-J` IS THE LINE. Without `-e` tmux returns plain text;
    // without `-J` a long command is already N rows of the pane's width, so nothing is
    // ever long enough to fold and the sheet carries the pane's width around with it.
    expect(ctx.calls[0]?.args).toEqual(["tmux", "capture-pane", "-p", "-e", "-J", "-S", "-200", "-t", "main"]);
    // The newest window takes the visible screen with it, so it passes no `-E` at all —
    // `-E 0` would mean the FIRST line of the screen rather than its last.
    expect(ctx.calls[0]?.args).not.toContain("-E");
    expect(ctx.calls[1]?.args).toEqual([
      "tmux", "capture-pane", "-p", "-e", "-J", "-S", "-400", "-E", "-200", "-t", "main",
    ]);
    expect(ctx.calls[2]?.args).toEqual([
      "tmux", "capture-pane", "-p", "-e", "-J", "-S", "-600", "-E", "-400", "-t", "main",
    ]);

    // ⚠ OLDEST FIRST IN THE ANSWER, NEWEST FIRST ON THE WIRE. The walk goes backwards so
    // that stopping early loses the OLD end; the sheet still reads top to bottom.
    expect(lines).toHaveLength(402);
    expect(lines[0]).toBe("a0");
    expect(lines[lines.length - 1]).toBe("c199");
    // A short window is the top of the history, and nothing is asked for beyond it.
    expect(reachedOldest).toBe(true);
    expect(ctx.calls).toHaveLength(3);
  });

  it("[TC-PDTERM-137] halves a window that still arrives clipped instead of giving up on it", async () => {
    // One pane of very long lines should cost extra round trips, not lose its colour —
    // and never return the clipped result, whose surviving half is the OLDEST output.
    const clipped = { ...ok("ancient\n"), truncated: true };
    ctx = build(clipped, clipped, ok("recent\n"));
    const { lines } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    expect(ctx.calls[0]?.args).toContain("-200");
    expect(ctx.calls[1]?.args).toContain("-100");
    expect(ctx.calls[2]?.args).toContain("-50");
    expect(lines).toEqual(["recent"]);
    expect(lines).not.toContain("ancient");
  });

  it("[TC-PDTERM-137] stops at once on an empty pane rather than walking its whole budget", async () => {
    ctx = build(ok(""));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });
    expect(lines).toEqual([]);
    expect(reachedOldest).toBe(true);
    expect(ctx.calls).toHaveLength(1);
  });

  it("[TC-PDTERM-137] leaves the bytes alone, because only the parser can read them", async () => {
    /**
     * ⚠ THE TRIMMING THAT USED TO LIVE HERE WAS DEAD THE MOMENT `-e` ARRIVED: with
     * escapes in the stream a line ends in `ESC[0m` AFTER its padding, so `/\s+$/`
     * matched nothing. Trimming here would now be a second opinion about bytes this
     * layer cannot read, so padding and blank tails belong to `parseAnsiLines`.
     */
    ctx = build(ok("\u001b[31mred\u001b[0m   \n   \n"));
    const { lines } = await ctx.controller.history(SESSION, HOST, { session: "main" });
    expect(lines).toEqual(["\u001b[31mred\u001b[0m   ", "   "]);
  });

  it("separates an agent that cannot find tmux from a command tmux refused", async () => {
    // ⚠ REPORTED AS "the button does nothing" ON A MAC RUNNING TMUX. `exec` used to look
    // on PATH alone, so a launchd-started agent missed a homebrew tmux it was spawning
    // panes with seconds earlier. The message a caller reads has to point at the agent,
    // not tell them to install something they already have.
    ctx = build({ ...ok(), exitCode: -1, code: "COMMAND_NOT_FOUND" });
    await expect(ctx.controller.copyMode(SESSION, HOST, { session: "main", action: "enter" })).rejects.toMatchObject({
      code: "MUX_NOT_FOUND",
    });

    ctx = build({ ...ok(), exitCode: 1, stderr: "can't find pane: nope\n" });
    const refused = ctx.controller.copyMode(SESSION, HOST, { session: "nope", action: "enter" });
    // tmux's own words, not a sentence invented here — it names the actual problem.
    await expect(refused).rejects.toMatchObject({ code: "MUX_COMMAND_FAILED", message: "can't find pane: nope" });
    await expect(refused).rejects.toBeInstanceOf(AppException);
  });

  it("refuses a session name that could be read as an option", async () => {
    const bad = ["a b", "main;rm", "", "x".repeat(33), "../etc", "$(id)", "main\nkill"];
    const accepted: string[] = [];
    for (const session of bad) {
      const errors = await validate(plainToInstance(MuxCopyModeDto, { session, action: "enter" }));
      if (errors.length === 0) accepted.push(session);
    }
    expect(accepted).toEqual([]);

    /**
     * ⚠ A LEADING DASH IS ALLOWED, AND THAT IS NOT AN OVERSIGHT. The contract's pattern
     * permits `-` anywhere, so `tmux new -A -s -X` can create a session called `-X` and
     * this endpoint has to be able to address the sessions that exist. It is safe for
     * the same reason it is possible: the name is always the VALUE of `-t`, which argv
     * consumes positionally, so it is never parsed as an option of its own. Narrowing
     * it here instead would leave such a pane visible in the dashboard and unscrollable,
     * and would put a second, stricter copy of the pattern next to the contract's.
     */
    expect(await validate(plainToInstance(MuxCopyModeDto, { session: "-X", action: "enter" }))).toHaveLength(0);
    expect(await validate(plainToInstance(MuxCopyModeDto, { session: "main", action: "enter" }))).toHaveLength(0);
    expect(await validate(plainToInstance(MuxCopyModeDto, { session: "main", action: "nope" }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(MuxHistoryDto, { session: "clude-1" }))).toHaveLength(0);
  });
});

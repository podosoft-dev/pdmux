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
    // The first round trip is not a capture: it asks the pane how much it holds, because that
    // number is what says where the walk ends (see the `-J` case below).
    ctx = build(ok("600 0"), full("c"), full("b"), ok("a0\na1\n"));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    expect(ctx.calls[0]?.args).toEqual([
      "tmux", "display-message", "-p", "-t", "main", "#{history_size} #{alternate_on}",
    ]);

    // ⚠ `-e` IS THE COLOUR and `-J` IS THE LINE. Without `-e` tmux returns plain text;
    // without `-J` a long command is already N rows of the pane's width, so nothing is
    // ever long enough to fold and the sheet carries the pane's width around with it.
    expect(ctx.calls[1]?.args).toEqual(["tmux", "capture-pane", "-p", "-e", "-J", "-S", "-200", "-t", "main"]);
    // The newest window takes the visible screen with it, so it passes no `-E` at all —
    // `-E 0` would mean the FIRST line of the screen rather than its last.
    expect(ctx.calls[1]?.args).not.toContain("-E");
    expect(ctx.calls[2]?.args).toEqual([
      "tmux", "capture-pane", "-p", "-e", "-J", "-S", "-400", "-E", "-200", "-t", "main",
    ]);
    expect(ctx.calls[3]?.args).toEqual([
      "tmux", "capture-pane", "-p", "-e", "-J", "-S", "-600", "-E", "-400", "-t", "main",
    ]);

    // ⚠ OLDEST FIRST IN THE ANSWER, NEWEST FIRST ON THE WIRE. The walk goes backwards so
    // that stopping early loses the OLD end; the sheet still reads top to bottom.
    expect(lines).toHaveLength(402);
    expect(lines[0]).toBe("a0");
    expect(lines[lines.length - 1]).toBe("c199");
    // Three windows of 200 is the 600 lines the pane said it holds, so there is nothing above
    // them and nothing more is asked for.
    expect(reachedOldest).toBe(true);
    expect(ctx.calls).toHaveLength(4);
  });

  it("[TC-PDTERM-137] halves a window that still arrives clipped instead of giving up on it", async () => {
    // One pane of very long lines should cost extra round trips, not lose its colour —
    // and never return the clipped result, whose surviving half is the OLDEST output.
    const clipped = { ...ok("ancient\n"), truncated: true };
    ctx = build(ok("500 0"), clipped, clipped, ok("recent\n"));
    const { lines } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    expect(ctx.calls[1]?.args).toContain("-200");
    expect(ctx.calls[2]?.args).toContain("-100");
    expect(ctx.calls[3]?.args).toContain("-50");
    expect(lines).toEqual(["recent"]);
    expect(lines).not.toContain("ancient");
  });

  it("[TC-PDTERM-137] stops at once on an empty pane rather than walking its whole budget", async () => {
    ctx = build(ok("0 0"), ok(""));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });
    expect(lines).toEqual([]);
    expect(reachedOldest).toBe(true);
    expect(ctx.calls).toHaveLength(2);
  });

  it("[TC-PDTERM-137] keeps walking past a window that `-J` made shorter than the rows asked for", async () => {
    /**
     * ⚠ THE STOP CONDITION USED TO BE `captured.length < span`, WHICH `-J` CONTRADICTS. Joining
     * wrapped rows is what `-J` is for, so a window of 200 ROWS legitimately arrives as fewer
     * LINES — measured in an isolated tmux session, 210 rows of wrapped output came back as 54
     * joined lines. The old test read that as the top of the history and stopped at the first
     * window, which is why `MAX_LINES` was unreachable and the sheet was short on exactly the
     * panes whose lines wrap.
     *
     * `#{history_size}` is the number tmux itself keeps, so it is the one that decides.
     */
    const joined = (mark: string) => ok(Array.from({ length: 54 }, (_, i) => `${mark}${i}`).join("\n") + "\n");
    ctx = build(ok("400 0"), joined("newer"), joined("older"));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    // Two windows walked, not one — the second was asked for even though the first came back
    // at a quarter of the rows requested.
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[2]?.args).toContain("-400");
    expect(lines).toHaveLength(108);
    // Oldest first in the answer.
    expect(lines[0]).toBe("older0");
    expect(lines[lines.length - 1]).toBe("newer53");
    // 2 x 200 rows is the 400 the pane said it holds.
    expect(reachedOldest).toBe(true);
  });

  it("[TC-PDTERM-137] stops when a window past the top comes back as the visible screen", async () => {
    /**
     * ⚠ MEASURED (tmux 3.7b, isolated 80x24 pane, `history_size` 379, 2026-08-17): a window that
     * starts above the oldest line tmux holds comes back as the VISIBLE SCREEN, not as nothing —
     * `-S -400 -E -300`, `-S -600 -E -400`, `-S -800 -E -600` and `-S -2000 -E -1800` each
     * returned the same 24 newest rows. Inside the history the same tmux pages exactly as
     * documented (`-S -200 -E -100` gave lines 178 to 278), so this is the boundary, not a broken
     * flag.
     *
     * The old `captured.length < span` stop hid this by accident (24 is less than 200). Without a
     * guard the walk would now ask forty times and the sheet would carry forty copies of one
     * screen. Running past the top IS how a walk learns there is nothing above it, so
     * `reachedOldest` is true.
     */
    const screen = ["tail1", "tail2"];
    const newest = ok([...Array.from({ length: 8 }, (_, i) => `body${i}`), ...screen].join("\n") + "\n");
    ctx = build(ok("5000 0"), newest, ok(screen.join("\n") + "\n"), ok("never asked\n"));
    const { lines, reachedOldest } = await ctx.controller.history(SESSION, HOST, { session: "main" });

    expect(ctx.calls).toHaveLength(3);
    expect(lines).toHaveLength(10);
    expect(lines).not.toContain("never asked");
    expect(reachedOldest).toBe(true);
  });

  it("[TC-PDTERM-137] says when the pane is a full-screen program, because then there is no history", async () => {
    /**
     * ⚠ THIS IS THE DIFFERENCE BETWEEN A SHORT HISTORY AND NO HISTORY, and only the host can
     * answer it. A coding agent's TUI draws on the pane's ALTERNATE screen and tmux keeps history
     * for the normal one, so a capture returns that program's current screenful and nothing
     * before it. Measured across one fleet on 2026-08-17: `alternate_on 1` with `history_size` 48
     * on one host, `alternate_on 0` with 1991 on another — the same dashboard, the same coding
     * agent, opposite answers. The sheet renders both, so it has to be told which it is holding.
     */
    ctx = build(ok("48 1"), ok("one screen\n"));
    expect((await ctx.controller.history(SESSION, HOST, { session: "main" })).screenOnly).toBe(true);

    ctx = build(ok("1991 0"), ok("real history\n"));
    expect((await ctx.controller.history(SESSION, HOST, { session: "main" })).screenOnly).toBe(false);
  });

  it("[TC-PDTERM-137] still captures when the pane cannot be measured", async () => {
    // A `display-message` that answers nothing useful is not a reason to show the reader an empty
    // sheet — the capture is still worth making, bounded by the budget this layer already has.
    ctx = build(ok("no such format\n"), ok("line\n"));
    const { lines, screenOnly } = await ctx.controller.history(SESSION, HOST, { session: "main" });
    expect(lines).toEqual(["line"]);
    expect(screenOnly).toBe(false);
  });

  it("[TC-PDTERM-137] leaves the bytes alone, because only the parser can read them", async () => {
    /**
     * ⚠ THE TRIMMING THAT USED TO LIVE HERE WAS DEAD THE MOMENT `-e` ARRIVED: with
     * escapes in the stream a line ends in `ESC[0m` AFTER its padding, so `/\s+$/`
     * matched nothing. Trimming here would now be a second opinion about bytes this
     * layer cannot read, so padding and blank tails belong to `parseAnsiLines`.
     */
    ctx = build(ok("2 0"), ok("\u001b[31mred\u001b[0m   \n   \n"));
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

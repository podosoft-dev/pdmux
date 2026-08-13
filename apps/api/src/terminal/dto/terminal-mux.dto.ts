import { SESSION_NAME_PATTERN } from "@pdmux/protocol";
import { IsIn, IsString, Matches } from "class-validator";

/**
 * ⚠ THE NAME BECOMES `tmux -t <name>`. `exec` runs the binary directly with no shell,
 * so a semicolon here is a character rather than a second command — but an unchecked
 * string still reaches an argument parser as an option (`-X`, `--`), and the contract
 * already says what a session may be called. Reuse that pattern; never restate it.
 */
export class MuxCopyModeDto {
  @IsString()
  @Matches(SESSION_NAME_PATTERN, { message: "session must be 1-32 word characters" })
  session!: string;

  /** `enter` puts the pane in copy-mode; `exit` takes it back out. */
  @IsIn(["enter", "exit"])
  action!: "enter" | "exit";
}

export class MuxHistoryDto {
  @IsString()
  @Matches(SESSION_NAME_PATTERN, { message: "session must be 1-32 word characters" })
  session!: string;
}

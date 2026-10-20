import { SESSION_NAME_PATTERN } from "@pdmux/protocol";
import { IsIn, IsString, IsOptional, IsUUID, Matches, ValidateIf } from "class-validator";

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

export class MuxSessionDto {
  @IsIn(["native", "tmux"])
  backend!: "native" | "tmux";
  @ValidateIf((value: MuxSessionDto) => value.backend === "native" || value.sessionId !== undefined)
  @IsUUID()
  sessionId?: string;
  @ValidateIf((value: MuxSessionDto) => value.backend === "tmux" || value.tmuxId !== undefined)
  @IsString()
  @Matches(/^\$[0-9]{1,16}$/)
  tmuxId?: string;
  @IsOptional()
  @IsString()
  session?: string;
}

export class MuxRenameDto extends MuxSessionDto {
  @IsString()
  @Matches(SESSION_NAME_PATTERN)
  name!: string;
}

export class MuxHistoryDto {
	@IsOptional()
	@IsIn(["native", "tmux"])
	backend?: "native" | "tmux";
	@IsOptional()
	@IsUUID()
	sessionId?: string;
  @IsString()
  @Matches(SESSION_NAME_PATTERN, { message: "session must be 1-32 word characters" })
  session!: string;
}

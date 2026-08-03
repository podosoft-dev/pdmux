import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { ExecResult } from "@pdmux/protocol";

import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * One command, out to an agent and back.
 *
 * The socket is a stream of independent frames, so a request/response shape has
 * to be built on top of it: this keeps a promise per `commandId` and settles it
 * when the matching `execResult` arrives. That is the same pairing `agentUpdate`
 * and `updateStatus` already use — the difference is that a caller is BLOCKED on
 * this one, which is why every failure path below settles rather than returns.
 */

/** Slightly past the agent's own ceiling, so its answer wins the race. */
const SERVER_GRACE_MS = 5_000;

interface Pending {
  resolve: (result: ExecResult) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class AgentExecService {
  private readonly logger = new Logger(AgentExecService.name);
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly hosts: HostsService,
  ) {}

  /**
   * Called from the ingest path when an `execResult` arrives.
   *
   * An id we are not waiting for is dropped without ceremony: it is what a retry
   * after a timeout looks like, and it is not an error.
   */
  settle(result: ExecResult): void {
    const waiter = this.pending.get(result.commandId);
    if (!waiter) return;
    this.pending.delete(result.commandId);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  async run(
    organizationId: string,
    hostId: string,
    input: { command: string; args?: string[]; cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Through the scope gate, so this cannot reach a host outside the key's scope.
    const host = await this.hosts.get(organizationId, hostId);
    if (!host.enabled) throw new AppException("HOST_DISABLED", "This host is disabled", 409);

    // ⚠ READ THE CAPABILITY, DO NOT ASSUME IT. An agent built before the exec
    // frame ignores it silently, and the caller would wait out the timeout for an
    // answer that was never coming. Refusing immediately, with a code, is the
    // difference between "update your agent" and "pdmux is broken".
    if (!host.capabilities?.includes("exec")) {
      throw new AppException(
        "HOST_EXEC_UNSUPPORTED",
        "This host's agent is too old to run commands. Update it from the dashboard.",
        409,
      );
    }

    const commandId = randomUUID();
    const timeoutMs = input.timeoutMs ?? 30_000;
    const frame = {
      type: "exec" as const,
      exec: {
        commandId,
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd ?? null,
        timeoutMs,
      },
    };

    const answered = new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        // The agent bounds the command itself; reaching here means the agent went
        // away mid-run. Reported as a timeout rather than a hang.
        resolve({
          commandId,
          exitCode: -1,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: true,
          code: "AGENT_SILENT",
          message: "The agent did not answer before the deadline",
        });
      }, timeoutMs + SERVER_GRACE_MS);
      this.pending.set(commandId, { resolve, timer });
    });

    if (!this.registry.sendToHost(hostId, frame)) {
      const waiter = this.pending.get(commandId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(commandId);
      }
      throw new AppException("HOST_OFFLINE", "This host's agent is not connected", 409);
    }

    this.logger.log(`Dispatched command to host ${hostId}: ${input.command}`);
    return answered;
  }
}

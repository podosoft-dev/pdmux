import { inlineSafe, mimeOf } from "@pdmux/core";
import { FS_CAPS, FS_CHUNK_BYTES } from "@pdmux/protocol";
import { AppException } from "@podosoft/podokit-contracts";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { Elysia } from "elysia";
import { CreateAgentEnrollmentDto } from "../agents/dto/create-agent-enrollment.dto";
import { CreateAgentTokenDto } from "../agents/dto/create-agent-token.dto";
import { EnrollAgentDto } from "../agents/dto/enroll-agent.dto";
import { FleetUpdateAgentDto, UpdateAgentDto } from "../agents/dto/update-agent.dto";
import type { AuthSession } from "../auth/auth.service";
import type { AppPlugin } from "../core/services";
import { UpdateFleetSettingsDto } from "../fleet/dto/update-fleet-settings.dto";
import {
  assertCanManageFleet,
  isPersonalScope,
  mcpCeilingFor,
  resolveScopeId,
} from "../fleet/session-scope";
import { CreateHostDto } from "../hosts/dto/create-host.dto";
import {
  CreateHostGitRootDto,
  UpdateHostGitRootDto,
} from "../hosts/dto/host-git-root.dto";
import {
  CreateHostServiceDto,
  ReorderHostServicesDto,
  UpdateHostServiceDto,
} from "../hosts/dto/host-service.dto";
import { MoveHostDto } from "../hosts/dto/move-host.dto";
import { ReorderHostsDto } from "../hosts/dto/reorder-hosts.dto";
import { SetEnabledDto } from "../hosts/dto/set-enabled.dto";
import { UpdateHostDto } from "../hosts/dto/update-host.dto";
import { CreateMcpKeyDto } from "../mcp/dto/create-mcp-key.dto";
import { CreateMcpTokenDto } from "../mcp/dto/create-mcp-token.dto";
import { MCP_TIERS } from "../mcp/mcp-tier";
import { MCP_TOKEN_EXPIRY_DAYS } from "../mcp/user-mcp-key.crypto";
import { PutHostPrefDto, PutLayoutDto } from "../prefs/dto/prefs.dto";
import { MuxCopyModeDto, MuxHistoryDto } from "../terminal/dto/terminal-mux.dto";
import { PDMUX, type PdmuxServices } from "./pdmux.services";

type DtoConstructor<T extends object> = new () => T;

function dto<T extends object>(constructor: DtoConstructor<T>, value: unknown): T {
  const instance = plainToInstance(constructor, value ?? {});
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (errors.length > 0) {
    const fields = errors.map((error) => error.property).join(", ");
    throw new AppException("VALIDATION_ERROR", `Request validation failed: ${fields}`, 400);
  }
  return instance;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function userId(session: AuthSession): string {
  if (typeof session.user.id !== "string" || session.user.id.length === 0) {
    throw new AppException("AUTH_REQUIRED", "No user is attached to the session", 401);
  }
  return session.user.id;
}

function assertFilePath(path: string): string {
  if (path.length > FS_CAPS.maxPathChars) {
    throw new AppException("FILE_PATH_INVALID", "Invalid file path", 400);
  }
  return path;
}

function requireFilePath(path: string): string {
  const clean = assertFilePath(path);
  if (clean.length === 0) {
    throw new AppException("FILE_PATH_REQUIRED", "A file path is required", 400);
  }
  return clean;
}

function rangeStart(header: string | null): number {
  const match = /^bytes=(\d+)-\d*$/.exec((header ?? "").trim());
  if (!match) return 0;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) && start >= 0 ? start : 0;
}

async function audit<T>(
  services: PdmuxServices,
  request: Request,
  session: AuthSession,
  action: string,
  operation: () => Promise<T> | T,
  target: (result: T) => {
    type?: string;
    id?: string;
    label?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<T> {
  const result = await operation();
  await services.audit.recordRequest(action, request, session, target(result));
  return result;
}

async function sessionFor(services: PdmuxServices, request: Request): Promise<AuthSession> {
  return services.auth.requireSession(request);
}

function fileDownload(
  services: PdmuxServices,
  request: Request,
  session: AuthSession,
  hostId: string,
  path: string,
  inline: boolean,
): Promise<Response> {
  return (async () => {
    const scope = resolveScopeId(session);
    const clean = requireFilePath(path);
    const name = clean.split("/").pop() ?? "download";
    const mime = mimeOf(name);
    const from = rangeStart(request.headers.get("range"));
    const first = await services.agentFiles.chunk(scope, hostId, clean, from, FS_CHUNK_BYTES);
    if (first.error) throw new AppException("FILE_READ_FAILED", first.error, 502);
    if (from > 0 && from >= first.size) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${first.size}` },
      });
    }

    let offset = from;
    let slice = first;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const raw = Buffer.from(slice.data, "base64");
        if (raw.length > 0) controller.enqueue(raw);
        offset += raw.length;
        if (slice.eof || raw.length === 0) {
          controller.close();
          return;
        }
        try {
          slice = await services.agentFiles.chunk(scope, hostId, clean, offset, FS_CHUNK_BYTES);
          if (slice.error) controller.error(new Error(slice.error));
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const asInline = inline && inlineSafe(mime);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "content-type": mime,
      "content-disposition": `${asInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-length": String(Math.max(first.size - from, 0)),
    });
    if (from > 0) headers.set("content-range", `bytes ${from}-${Math.max(first.size - 1, from)}/${first.size}`);
    return new Response(stream, { status: from > 0 ? 206 : 200, headers });
  })();
}

async function fileUpload(
  services: PdmuxServices,
  request: Request,
  session: AuthSession,
  hostId: string,
  path: string,
): Promise<Awaited<ReturnType<PdmuxServices["agentFiles"]["put"]>>> {
  const clean = requireFilePath(path);
  const scope = resolveScopeId(session);
  const reader = request.body?.getReader();
  let pending = Buffer.alloc(0);
  let offset = 0;
  let create = true;
  let last: Awaited<ReturnType<PdmuxServices["agentFiles"]["put"]>> | null = null;

  while (reader) {
    const next = await reader.read();
    if (next.done) break;
    pending = Buffer.concat([pending, Buffer.from(next.value)]);
    while (pending.length >= FS_CHUNK_BYTES) {
      const chunk = pending.subarray(0, FS_CHUNK_BYTES);
      pending = pending.subarray(FS_CHUNK_BYTES);
      last = await services.agentFiles.put(scope, hostId, clean, offset, chunk, create);
      if (last.error) throw new AppException("FILE_WRITE_FAILED", last.error, 502);
      offset += chunk.length;
      create = false;
    }
  }
  if (pending.length > 0 || last === null) {
    last = await services.agentFiles.put(scope, hostId, clean, offset, pending, create);
    if (last.error) throw new AppException("FILE_WRITE_FAILED", last.error, 502);
  }
  await services.audit.recordRequest("host.files.upload", request, session, {
    type: "host",
    id: hostId,
    label: clean,
  });
  return last;
}

export const pdmuxHttpPlugin: AppPlugin = (context) => {
  const services = context.services.resolve(PDMUX);
  return new Elysia({ name: "pdmux.http" })
    .get("/fleet/scope", async ({ request }) => {
      const session = await sessionFor(services, request);
      let canManage = true;
      try { assertCanManageFleet(session); } catch { canManage = false; }
      return { personal: isPersonalScope(session), canManage };
    })
    .get("/fleet/settings", async ({ request }) => {
      const session = await sessionFor(services, request);
      return services.fleetSettings.resolve(resolveScopeId(session));
    })
    .put("/fleet/settings", async ({ request, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const update = dto(UpdateFleetSettingsDto, body);
      return audit(services, request, session, "fleet.settings.update", () =>
        services.fleetSettings.update(resolveScopeId(session), update),
      (result) => ({ type: "fleet-settings", metadata: { settings: result } }));
    })
    .get("/hosts", async ({ request }) => {
      const session = await sessionFor(services, request);
      return services.hosts.list(resolveScopeId(session));
    })
    .get("/hosts/:hostId", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.hosts.getView(resolveScopeId(session), params.hostId);
    })
    .post("/hosts", async ({ request, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(CreateHostDto, body);
      set.status = 201;
      return audit(services, request, session, "host.create", () =>
        services.hosts.createWithEnrollment(resolveScopeId(session), input, userId(session)),
      (result) => ({
        type: "host",
        id: result.id,
        label: result.label,
        metadata: {
          enrollmentIssued: Boolean(result.enrollment),
          enrollmentId: result.enrollment?.id ?? null,
        },
      }));
    })
    .patch("/hosts/:hostId", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.update", () =>
        services.hosts.update(resolveScopeId(session), params.hostId, dto(UpdateHostDto, body)),
      (result) => ({ type: "host", id: result.id, label: result.label }));
    })
    .delete("/hosts/:hostId", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.delete", () =>
        services.hosts.remove(resolveScopeId(session), params.hostId),
      (result) => ({ type: "host", id: result.id, label: result.label }));
    })
    .put("/hosts/:hostId/enabled", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(SetEnabledDto, body);
      return audit(services, request, session, "host.enable", () =>
        services.hosts.setEnabled(resolveScopeId(session), params.hostId, input.enabled),
      (result) => ({ type: "host", id: result.id, label: result.label }));
    })
    .post("/hosts/:hostId/move", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(MoveHostDto, body);
      return audit(services, request, session, "host.move", () =>
        services.hosts.move(resolveScopeId(session), params.hostId, input.targetEmail),
      (result) => ({
        type: "host",
        id: result.id,
        label: result.label,
        metadata: { targetEmail: input.targetEmail },
      }));
    })
    .put("/hosts/reorder", async ({ request, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(ReorderHostsDto, body);
      return audit(services, request, session, "host.reorder", () =>
        services.hosts.reorder(resolveScopeId(session), input.ids),
      (result) => ({ type: "host", metadata: { order: result.map((host) => host.id) } }));
    })
    .get("/hosts/:hostId/services", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.hostServices.list(resolveScopeId(session), params.hostId);
    })
    .post("/hosts/:hostId/services", async ({ request, params, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      set.status = 201;
      return audit(services, request, session, "host.service.create", () =>
        services.hostServices.create(resolveScopeId(session), params.hostId, dto(CreateHostServiceDto, body)),
      (result) => ({ type: "host-service", id: result.id, label: result.label }));
    })
    .put("/hosts/:hostId/services/reorder", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(ReorderHostServicesDto, body);
      return audit(services, request, session, "host.service.reorder", () =>
        services.hostServices.reorder(resolveScopeId(session), params.hostId, input.ids),
      (result) => ({ type: "host-service", metadata: { order: result.map((service) => service.id) } }));
    })
    .patch("/hosts/:hostId/services/:id", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.service.update", () =>
        services.hostServices.update(resolveScopeId(session), params.hostId, params.id, dto(UpdateHostServiceDto, body)),
      (result) => ({ type: "host-service", id: result.id, label: result.label }));
    })
    .delete("/hosts/:hostId/services/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.service.delete", () =>
        services.hostServices.remove(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "host-service", id: result.id, label: result.label }));
    })
    .get("/hosts/:hostId/git-roots", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.hostGitRoots.list(resolveScopeId(session), params.hostId);
    })
    .post("/hosts/:hostId/git-roots", async ({ request, params, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      set.status = 201;
      return audit(services, request, session, "host.gitroot.create", () =>
        services.hostGitRoots.create(resolveScopeId(session), params.hostId, dto(CreateHostGitRootDto, body)),
      (result) => ({ type: "host-git-root", id: result.id, label: result.path }));
    })
    .patch("/hosts/:hostId/git-roots/:id", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.gitroot.update", () =>
        services.hostGitRoots.update(resolveScopeId(session), params.hostId, params.id, dto(UpdateHostGitRootDto, body)),
      (result) => ({ type: "host-git-root", id: result.id, label: result.path }));
    })
    .delete("/hosts/:hostId/git-roots/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "host.gitroot.delete", () =>
        services.hostGitRoots.remove(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "host-git-root", id: result.id, label: result.path }));
    })
    .get("/hosts/:hostId/repos", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.git.listRepos(resolveScopeId(session), params.hostId);
    })
    .get("/hosts/:hostId/repos/:repoId", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.git.graph(resolveScopeId(session), params.hostId, params.repoId);
    })
    .get("/hosts/:hostId/repos/:repoId/working-diff", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.git.workingDiff(resolveScopeId(session), params.hostId, params.repoId);
    })
    .get("/hosts/:hostId/repos/:repoId/commits/:sha/detail", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.git.commitDetail(resolveScopeId(session), params.hostId, params.repoId, params.sha);
    })
    .get("/hosts/:hostId/repos/:repoId/commits/:sha/tree", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.git.commitTree(resolveScopeId(session), params.hostId, params.repoId, params.sha);
    })
    .get("/hosts/:hostId/repos/:repoId/commits/:sha/blob", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      return services.git.commitBlob(
        resolveScopeId(session),
        params.hostId,
        params.repoId,
        params.sha,
        stringValue(query.path),
      );
    })
    .get("/hosts/:hostId/metrics", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      const scope = resolveScopeId(session);
      const host = await services.hosts.get(scope, params.hostId);
      const settings = await services.fleetSettings.resolve(scope);
      const requested = Number.parseInt(stringValue(query.window, "3600"), 10);
      const windowSec = Math.min(7 * 24 * 60 * 60, Math.max(settings.metricStepSec, Number.isFinite(requested) ? requested : 3600));
      const series = await services.metrics.series(host.id, { windowSec, stepSec: settings.metricStepSec });
      return { hostId: host.id, ...series, latest: await services.metrics.latest(host.id) };
    })
    .post("/hosts/:hostId/collect", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const what = record(body).what;
      if (what !== "heartbeat" && what !== "repos" && what !== "remote") {
        throw new AppException("VALIDATION_ERROR", "Invalid collection target", 400);
      }
      const host = await services.hosts.get(resolveScopeId(session), params.hostId);
      if (!services.agentRegistry.isConnected(host.id)) {
        throw new AppException("HOST_OFFLINE", "No agent is connected to this host", 409);
      }
      const ackFrames = what === "repos" ? await services.agentAck.ackAllRepos(host.id) : 0;
      services.agentRegistry.sendToHost(host.id, { type: "collect", what });
      const result = { hostId: host.id, what, ackFrames };
      await services.audit.recordRequest("agent.collect", request, session, {
        type: "host",
        id: host.id,
        metadata: { what },
      });
      return result;
    })
    .post("/agent/enroll", async ({ request, body, set }) => {
      const input = dto(EnrollAgentDto, body);
      set.status = 201;
      const result = await services.agentEnrollments.redeem(
        input.code,
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      );
      return result;
    })
    .get("/agent-auth-failures", async ({ request }) => {
      await services.auth.requireAdmin(request);
      return services.agentAuthFailures.recent();
    })
    .post("/hosts/:hostId/enrollments", async ({ request, params, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(CreateAgentEnrollmentDto, body);
      set.status = 201;
      return audit(services, request, session, "agent.enrollment.create", () =>
        services.agentEnrollments.create(
          resolveScopeId(session),
          params.hostId,
          userId(session),
          input.tokenExpiresInDays ?? null,
        ),
      (result) => ({
        type: "agent-enrollment",
        id: result.id,
        metadata: { hostId: result.hostId, expiresAt: result.expiresAt },
      }));
    })
    .get("/hosts/:hostId/enrollments/current", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return services.agentEnrollments.current(resolveScopeId(session), params.hostId);
    })
    .delete("/hosts/:hostId/enrollments/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "agent.enrollment.revoke", () =>
        services.agentEnrollments.revoke(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "agent-enrollment", id: result.id }));
    })
    .get("/hosts/:hostId/tokens", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return services.agentTokens.list(resolveScopeId(session), params.hostId);
    })
    .post("/hosts/:hostId/tokens", async ({ request, params, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(CreateAgentTokenDto, body);
      set.status = 201;
      return audit(services, request, session, "agent.token.create", () =>
        services.agentTokens.mint(resolveScopeId(session), params.hostId, input.name, input.expiresInDays ?? null),
      (result) => ({ type: "agent-token", id: result.id, label: result.name }));
    })
    .post("/hosts/:hostId/tokens/:id/rotate", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "agent.token.rotate", () =>
        services.agentTokens.rotate(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "agent-token", id: result.id, label: result.name }));
    })
    .delete("/hosts/:hostId/tokens/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "agent.token.revoke", () =>
        services.agentTokens.revoke(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "agent-token", id: result.id, label: result.name }));
    })
    .post("/hosts/:hostId/agent/update", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(UpdateAgentDto, body);
      return audit(services, request, session, "agent.update", () =>
        services.agentUpdates.updateHost(resolveScopeId(session), params.hostId, {
          version: input.version ?? null,
          force: input.force ?? false,
        }),
      (result) => ({
        type: "host",
        id: result.hostId,
        label: result.label,
        metadata: { commandId: result.commandId, version: result.version, sha256: result.sha256 },
      }));
    })
    .post("/fleet/agent/update", async ({ request, body }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      const input = dto(FleetUpdateAgentDto, body);
      return audit(services, request, session, "agent.update.fleet", () =>
        services.agentUpdates.updateFleet(resolveScopeId(session), input),
      (result) => ({
        type: "fleet",
        metadata: {
          version: result.version,
          requested: result.requested,
          started: result.started.map((command) => command.hostId),
          failed: result.failed,
          notAttempted: result.notAttempted,
          stopped: result.stopped,
          summary: result.summary,
        },
      }));
    })
    .get("/hosts/:hostId/files", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      return services.agentFiles.list(resolveScopeId(session), params.hostId, assertFilePath(stringValue(query.path)));
    })
    .get("/hosts/:hostId/files/content", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      return services.agentFiles.read(resolveScopeId(session), params.hostId, requireFilePath(stringValue(query.path)));
    })
    .get("/hosts/:hostId/files/download", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      return fileDownload(services, request, session, params.hostId, stringValue(query.path), query.inline === "1");
    })
    .post("/hosts/:hostId/files/upload", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      return fileUpload(services, request, session, params.hostId, stringValue(query.path));
    }, { parse: "none" })
    .delete("/hosts/:hostId/files", async ({ request, params, query }) => {
      const session = await sessionFor(services, request);
      const path = requireFilePath(stringValue(query.path));
      const result = await services.agentFiles.remove(
        resolveScopeId(session),
        params.hostId,
        path,
        query.recursive === "1",
      );
      await services.audit.recordRequest("host.files.delete", request, session, {
        type: "host",
        id: params.hostId,
        label: path,
        metadata: { recursive: query.recursive === "1" },
      });
      return result;
    })
    .get("/prefs", async ({ request }) => {
      const session = await sessionFor(services, request);
      return services.prefs.read(userId(session));
    })
    .put("/prefs/layouts/:name", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      const input = dto(PutLayoutDto, body);
      return services.prefs.putLayout(userId(session), params.name, input.payload, input.isDefault ?? false);
    })
    .delete("/prefs/layouts/:name", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return services.prefs.deleteLayout(userId(session), params.name);
    })
    .put("/prefs/hosts/:hostId", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      const input = dto(PutHostPrefDto, body);
      return services.prefs.putHostPref(userId(session), resolveScopeId(session), params.hostId, input.widgets);
    })
    .post("/terminal/:hostId/copy-mode", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      return services.terminalMux.copyMode(session, params.hostId, dto(MuxCopyModeDto, body));
    })
    .post("/terminal/:hostId/history", async ({ request, params, body }) => {
      const session = await sessionFor(services, request);
      return services.terminalMux.history(session, params.hostId, dto(MuxHistoryDto, body));
    })
    .get("/hosts/:hostId/mcp-keys", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return services.hostMcpKeys.list(resolveScopeId(session), params.hostId);
    })
    .post("/hosts/:hostId/mcp-keys", async ({ request, params, body, set }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      set.status = 201;
      return audit(services, request, session, "mcp.key.create", () =>
        services.hostMcpKeys.mint(resolveScopeId(session), params.hostId, dto(CreateMcpKeyDto, body), userId(session)),
      (result) => ({ type: "mcp-key", id: result.id, label: result.label }));
    })
    .delete("/hosts/:hostId/mcp-keys/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      assertCanManageFleet(session);
      return audit(services, request, session, "mcp.key.revoke", () =>
        services.hostMcpKeys.revoke(resolveScopeId(session), params.hostId, params.id),
      (result) => ({ type: "mcp-key", id: result.id, label: result.label }));
    })
    .get("/account/mcp-tokens/policy", async ({ request }) => {
      const session = await sessionFor(services, request);
      return { ceiling: mcpCeilingFor(session), tiers: MCP_TIERS, expiryDays: MCP_TOKEN_EXPIRY_DAYS };
    })
    .get("/account/mcp-tokens", async ({ request }) => {
      const session = await sessionFor(services, request);
      return services.userMcpKeys.list(resolveScopeId(session), userId(session));
    })
    .post("/account/mcp-tokens", async ({ request, body, set }) => {
      const session = await sessionFor(services, request);
      set.status = 201;
      return audit(services, request, session, "mcp.token.create", () =>
        services.userMcpKeys.mint(resolveScopeId(session), userId(session), dto(CreateMcpTokenDto, body)),
      (result) => ({ type: "mcp-token", id: result.id, label: result.label, metadata: { tier: result.tier } }));
    })
    .delete("/account/mcp-tokens/:id", async ({ request, params }) => {
      const session = await sessionFor(services, request);
      return audit(services, request, session, "mcp.token.revoke", () =>
        services.userMcpKeys.revoke(resolveScopeId(session), userId(session), params.id),
      (result) => ({ type: "mcp-token", id: result.id, label: result.label, metadata: { tier: result.tier } }));
    })
    .all("/mcp", ({ request }) => services.mcp.handle(request), {
      detail: { hide: true },
    })
    .get("/agent-kit/manifest", () => services.agentKit.manifest(), {
      detail: { hide: true },
    })
    .get("/agent-kit", () => services.agentKit.download(), {
      detail: { hide: true },
    });
};

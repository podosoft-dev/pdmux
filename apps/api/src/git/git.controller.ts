import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import type { CommitDetail, WorkingDiff } from "@pdmux/protocol";
import { resolveScopeId } from "../fleet/session-scope";
import type { DetailResponse, RepoGraph } from "./git.service";
import { GitService } from "./git.service";
import type { Repo } from "./repo.entity";

@ApiTags("git")
@Controller("hosts/:hostId/repos")
export class GitController {
  constructor(private readonly git: GitService) {}

  @Get()
  list(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
  ): Promise<Repo[]> {
    return this.git.listRepos(resolveScopeId(session), hostId);
  }

  /** Graph rows only — bodies and patches are fetched per click, below. */
  @Get(":repoId")
  graph(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("repoId", ParseUUIDPipe) repoId: string,
  ): Promise<RepoGraph> {
    return this.git.graph(resolveScopeId(session), hostId, repoId);
  }

  @Get(":repoId/working-diff")
  workingDiff(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("repoId", ParseUUIDPipe) repoId: string,
  ): Promise<DetailResponse<WorkingDiff>> {
    return this.git.workingDiff(resolveScopeId(session), hostId, repoId);
  }

  @Get(":repoId/commits/:sha/detail")
  commitDetail(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("repoId", ParseUUIDPipe) repoId: string,
    @Param("sha") sha: string,
  ): Promise<DetailResponse<CommitDetail>> {
    return this.git.commitDetail(resolveScopeId(session), hostId, repoId, sha);
  }
}

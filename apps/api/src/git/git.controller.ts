import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import type { CommitDetail, GitBlob, GitTree, WorkingDiff } from "@pdmux/protocol";
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

  /**
   * The paths that existed at a commit — metadata only, no contents.
   *
   * ⚠ THE LISTING AND THE FILES ARE TWO CALLS, AND THAT IS THE POINT. A tree is a
   * few thousand paths; the files under it are the whole repository. Fetching both
   * at once would send megabytes to draw a list nobody has clicked into yet.
   */
  @Get(":repoId/commits/:sha/tree")
  commitTree(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("repoId", ParseUUIDPipe) repoId: string,
    @Param("sha") sha: string,
  ): Promise<DetailResponse<GitTree>> {
    return this.git.commitTree(resolveScopeId(session), hostId, repoId, sha);
  }

  /**
   * One file's contents at a commit.
   *
   * ⚠ THE PATH IS A QUERY PARAMETER, NOT A ROUTE SEGMENT. A repository path
   * contains slashes and may contain anything else a filesystem allows; as a
   * segment it would need double encoding and would still collide with the route.
   */
  @Get(":repoId/commits/:sha/blob")
  commitBlob(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("repoId", ParseUUIDPipe) repoId: string,
    @Param("sha") sha: string,
    @Query("path") path: string,
  ): Promise<DetailResponse<GitBlob>> {
    return this.git.commitBlob(resolveScopeId(session), hostId, repoId, sha, path ?? "");
  }
}

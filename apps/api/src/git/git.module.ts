import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HostsModule } from "../hosts/hosts.module";
import { GitController } from "./git.controller";
import { GitDetailService } from "./git-detail.service";
import { GitIngestService } from "./git-ingest.service";
import { GitService } from "./git.service";
import { RepoCommit } from "./repo-commit.entity";
import { RepoRef } from "./repo-ref.entity";
import { Repo } from "./repo.entity";

// StorageService is provided by the @Global StorageModule, so GitDetailService can
// inject it without importing anything here.
@Module({
  imports: [TypeOrmModule.forFeature([Repo, RepoRef, RepoCommit]), HostsModule],
  controllers: [GitController],
  providers: [GitService, GitIngestService, GitDetailService],
  exports: [GitIngestService, GitService],
})
export class GitModule {}

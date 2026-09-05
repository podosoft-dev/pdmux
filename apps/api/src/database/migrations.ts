import type { MigrationInterface } from "typeorm";
import { InitAuditLogs1720300000000 } from "../migrations/1720300000000-InitAuditLogs";
import { InitAppSettings1720400000000 } from "../migrations/1720400000000-InitAppSettings";
import { InitAuthConfig1720500000000 } from "../migrations/1720500000000-InitAuthConfig";
import { InitFleet1730000000000 } from "../migrations/1730000000000-InitFleet";
import { InitAgentEnrollments1730100000000 } from "../migrations/1730100000000-InitAgentEnrollments";
import { AddHostAgentUpdate1730200000000 } from "../migrations/1730200000000-AddHostAgentUpdate";
import { AddRepoCommitSeq1730300000000 } from "../migrations/1730300000000-AddRepoCommitSeq";
import { AddRepoMissingSince1730400000000 } from "../migrations/1730400000000-AddRepoMissingSince";
import { AddHostAgentAddress1730500000000 } from "../migrations/1730500000000-AddHostAgentAddress";
import { AddHostMcpKeys1730600000000 } from "../migrations/1730600000000-AddHostMcpKeys";
import { AddAgentTokenExpiry1730700000000 } from "../migrations/1730700000000-AddAgentTokenExpiry";
import { AddAgentAuthFailures1730800000000 } from "../migrations/1730800000000-AddAgentAuthFailures";
import { AddHostLastSeenIndex1730900000000 } from "../migrations/1730900000000-AddHostLastSeenIndex";
import { AddHostServiceEnabled1731000000000 } from "../migrations/1731000000000-AddHostServiceEnabled";
import { AddHostGitRoots1731100000000 } from "../migrations/1731100000000-AddHostGitRoots";
import { AddUserMcpKeys1731200000000 } from "../migrations/1731200000000-AddUserMcpKeys";
import { AddMcpEnabledSetting1731300000000 } from "../migrations/1731300000000-AddMcpEnabledSetting";
import { AddRepoRemoteCheck1731400000000 } from "../migrations/1731400000000-AddRepoRemoteCheck";
import { AddHostMetricSwap1731500000000 } from "../migrations/1731500000000-AddHostMetricSwap";
import { AddServiceExposures1731600000000 } from "../migrations/1731600000000-AddServiceExposures";

/** Static imports survive bundling; runtime directory globs can silently load zero migrations. */
export const POSTGRES_MIGRATIONS: Array<new () => MigrationInterface> = [
  InitAuditLogs1720300000000,
  InitAppSettings1720400000000,
  InitAuthConfig1720500000000,
  InitFleet1730000000000,
  InitAgentEnrollments1730100000000,
  AddHostAgentUpdate1730200000000,
  AddRepoCommitSeq1730300000000,
  AddRepoMissingSince1730400000000,
  AddHostAgentAddress1730500000000,
  AddHostMcpKeys1730600000000,
  AddAgentTokenExpiry1730700000000,
  AddAgentAuthFailures1730800000000,
  AddHostLastSeenIndex1730900000000,
  AddHostServiceEnabled1731000000000,
  AddHostGitRoots1731100000000,
  AddUserMcpKeys1731200000000,
  AddMcpEnabledSetting1731300000000,
  AddRepoRemoteCheck1731400000000,
  AddHostMetricSwap1731500000000,
  AddServiceExposures1731600000000,
];

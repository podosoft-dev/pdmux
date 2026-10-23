import type { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";

/** A team member with the user's name and email, as the team UI lists them. */
export interface TeamMemberView {
  id: string;
  teamId: string;
  userId: string;
  name: string;
  email: string;
  createdAt: string | Date | null;
}

export const TEAM_NOT_FOUND = "TEAM_NOT_FOUND" as const;
export const TEAMS_DISABLED = "TEAMS_DISABLED" as const;

/** Teams need organizations as well; both switches must be on. */
export function assertTeamsEnabled(flags: { organization: boolean; teams: boolean }): void {
  if (!flags.organization || !flags.teams) {
    throw new AppException(TEAMS_DISABLED, "This feature is disabled.", 404);
  }
}

/**
 * Lists a team's members for any member of its organization. Better Auth's
 * `list-team-members` answers only to members of the team itself, so an
 * organization owner or manager could not see who is in a team they manage.
 * Rows come from the Better Auth `team`, `member`, `teamMember`, and `user`
 * tables. A team outside the organization, or a caller who is not a member of
 * it, gets {@link TEAM_NOT_FOUND}.
 */
export async function listTeamMembersFor(
  sql: SQL,
  callerId: string,
  organizationId: string,
  teamId: string,
): Promise<TeamMemberView[]> {
  const [allowed] = await sql<Array<{ id: string }>>`
    SELECT t."id" FROM "team" t
    JOIN "member" m ON m."organizationId" = t."organizationId" AND m."userId" = ${callerId}
    WHERE t."id" = ${teamId} AND t."organizationId" = ${organizationId}
  `;
  if (!allowed) throw new AppException(TEAM_NOT_FOUND, "Team not found", 404);
  return sql<TeamMemberView[]>`
    SELECT tm."id", tm."teamId", tm."userId", u."name", u."email", tm."createdAt"
    FROM "teamMember" tm
    JOIN "user" u ON u."id" = tm."userId"
    WHERE tm."teamId" = ${teamId}
    ORDER BY u."email"
  `;
}

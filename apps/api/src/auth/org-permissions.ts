import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, ownerAc, memberAc } from "better-auth/plugins/organization/access";

/** Access-control for organization MEMBERS (separate from the app-level roles in
 *  permissions.ts). Adds a "manager" role alongside the built-in owner/admin/member
 *  — any number of members can hold it, so an org can have several managers. A
 *  manager runs the org (members, invitations, settings) but can't delete it. */
export const orgAc = createAccessControl(defaultStatements);

export const orgRoles = {
  owner: ownerAc,
  admin: adminAc,
  manager: orgAc.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  member: memberAc,
};

/** Assignable org role names, surfaced to the admin UI. */
export const ORG_ROLE_NAMES = Object.keys(orgRoles);

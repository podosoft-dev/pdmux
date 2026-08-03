import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, userAc } from "better-auth/plugins/admin/access";

/** Access-control statement: the admin plugin's built-in resources (user, session)
 *  plus an example "content" resource. Add your own resources and actions here. */
export const statement = {
  ...defaultStatements,
  content: ["read", "create", "update", "delete"],
} as const;

export const ac = createAccessControl(statement);

/** Roles and what each may do. `admin` keeps full user/session control and all
 *  content actions; `moderator` manages content only; `user` can read content.
 *  Assign roles from the Users admin page; check them with the permission guard. */
export const roles = {
  admin: ac.newRole({ ...adminAc.statements, content: ["read", "create", "update", "delete"] }),
  moderator: ac.newRole({ content: ["read", "create", "update", "delete"] }),
  user: ac.newRole({ ...userAc.statements, content: ["read"] }),
};

/** Assignable role names, surfaced to the admin UI via /account/capabilities. */
export const ROLE_NAMES = Object.keys(roles);

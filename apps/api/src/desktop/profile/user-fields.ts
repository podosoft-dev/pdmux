import type { BetterAuthOptions } from "better-auth";

type UserFields = NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

// The user columns of the desktop profile. Server code shared with the desktop build
// reads the admin plugin's ban columns (the MCP authority selects `banned` and
// `banExpires`), and the desktop schema comes from these options, not from that
// plugin, so they are declared here with the plugin's definitions. Better Auth's
// migration adds them to a desktop database that lacks them.
export const DESKTOP_USER_FIELDS: UserFields = {
  role: { type: "string", defaultValue: "user", input: false },
  signupApproved: { type: "boolean", defaultValue: true, input: false },
  banned: { type: "boolean", defaultValue: false, required: false, input: false },
  banReason: { type: "string", required: false, input: false },
  banExpires: { type: "date", required: false, input: false },
};

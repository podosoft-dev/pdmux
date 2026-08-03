import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { isPersonalScope, assertCanManageFleet } from "./session-scope";

/** What this session's scope is, and whether it may be changed. */
export interface FleetScopeView {
  /** No organization selected — the scope is this user alone. */
  personal: boolean;
  /** Whether fleet mutations will be accepted for this session. */
  canManage: boolean;
}

/**
 * The permission the screens need in order to draw the right thing.
 *
 * The web app cannot work this out for itself: its `locals.session` carries an id
 * and nothing else, so it can see the user's role but not whether an organization
 * is active — and the rule needs both. Answering here keeps one copy of the rule.
 * A second copy in the loader is the kind that drifts, and drifting in the
 * permissive direction means offering a button that returns 403.
 *
 * Deliberately NOT part of `GET /fleet/settings`: that payload is the agent's
 * configuration contract (heartbeat interval, git roots, budgets) and is pushed to
 * every connected agent. A permission flag has no business travelling that path.
 */
@ApiTags("fleet")
@Controller("fleet/scope")
export class FleetScopeController {
  @Get()
  read(@Session() session: UserSession): FleetScopeView {
    let canManage = true;
    try {
      assertCanManageFleet(session);
    } catch {
      canManage = false;
    }
    return { personal: isPersonalScope(session), canManage };
  }
}

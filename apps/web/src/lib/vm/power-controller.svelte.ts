/**
 * The one place a power button press goes, for every pane and card in the shell.
 *
 * ONE CONFIRMATION FOR THE WHOLE SCREEN. Four panes on the same machine each draw a menu, and a
 * dialog per pane would be four places for a half-confirmed state to linger. The press lands
 * here; the dialog the shell renders reads `pending`.
 *
 * NOTHING HERE CHANGES WHAT THE SCREEN SAYS ABOUT THE MACHINE. A request that was accepted is
 * followed by a refresh, and the state every pane shows still comes from the server — this
 * class only remembers that THIS screen is waiting for an answer, so the button cannot be
 * pressed twice before it arrives.
 */
import { ApiError } from "@podosoft/podokit-api-client";
import { getContext, setContext } from "svelte";
import { toast } from "svelte-sonner";
import type { HostView } from "#lib/dashboard/types.js";
import { fmt } from "#lib/i18n/index.js";
import type { Messages } from "#lib/i18n/messages.js";
import { vmApi } from "./api";
import type { PowerItem } from "./power";
import type { VmAction } from "./types";

export interface PendingPower {
  host: HostView;
  item: PowerItem;
}

type ActionLabel = VmAction | "wake";

export class VmPowerController {
  pending = $state<PendingPower | null>(null);
  /** Hosts with a request from this screen still unanswered. */
  sending = $state<Record<string, boolean>>({});

  constructor(
    private readonly options: {
      refresh: () => Promise<void>;
      messages: () => Messages;
      canManage: () => boolean;
    },
  ) {}

  /** A menu item was chosen. Changes that cut terminals off ask first; waking does not. */
  choose(host: HostView, item: PowerItem): void {
    if (item.confirm === "none") {
      void this.run(host, item.action, item.label);
      return;
    }
    this.pending = { host, item };
  }

  /** The dialog said yes. */
  async confirm(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    await this.run(pending.host, pending.item.action, pending.item.label);
  }

  cancel(): void {
    this.pending = null;
  }

  async run(host: HostView, action: VmAction, label: ActionLabel = action): Promise<void> {
    if (this.sending[host.id]) return;
    this.sending = { ...this.sending, [host.id]: true };
    const t = this.options.messages();
    try {
      await vmApi.power(host.id, action);
      toast.message(fmt(t.vm.accepted, { operation: t.vm.operation[action], name: host.label }), {
        description: t.vm.action[label],
      });
    } catch (error) {
      toast.error(this.describe(error));
    } finally {
      const { [host.id]: _done, ...rest } = this.sending;
      this.sending = rest;
      await this.options.refresh().catch(() => undefined);
    }
  }

  /** A refusal in words, by its code — never the server's message. */
  describe(error: unknown, code = error instanceof ApiError ? error.code : "NETWORK_ERROR"): string {
    const t = this.options.messages();
    const known = t.vm.error as Record<string, string>;
    if (code === "VM_OPERATION_IN_PROGRESS") {
      const details = error instanceof ApiError && error.details && typeof error.details === "object"
        ? (error.details as { requestedBy?: unknown })
        : {};
      const name = typeof details.requestedBy === "string" && details.requestedBy ? details.requestedBy : t.vm.someone;
      return fmt(t.vm.error.VM_OPERATION_IN_PROGRESS, { name });
    }
    if (code === "VM_TASK_TIMEOUT" && this.options.canManage()) return t.vm.error.VM_TASK_TIMEOUT_ADMIN;
    return known[code] ?? fmt(t.vm.error.generic, { code });
  }
}

const KEY = Symbol("pdmux.vm.power");

export function provideVmPower(controller: VmPowerController): VmPowerController {
  setContext(KEY, controller);
  return controller;
}

/** `null` outside a screen that provides one — a component then draws no power controls. */
export function useVmPower(): VmPowerController | null {
  return getContext<VmPowerController | undefined>(KEY) ?? null;
}

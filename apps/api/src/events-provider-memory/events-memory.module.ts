import { EVENTS, MemoryEventBus } from "@podosoft/podokit-runtime";
import type { PodokitModule } from "../core/services";
import { PROVIDERS } from "../config/providers";

export const eventsMemoryModule: PodokitModule = {
  name: "events-memory",
  configure: (_env, services): void => {
    if (PROVIDERS.events !== "memory") return;
    const events = new MemoryEventBus({
      maxEventBytes: Number(process.env.SSE_MAX_EVENT_BYTES ?? 65_536),
    });
    services.register(EVENTS, events, () => events.close());
  },
};

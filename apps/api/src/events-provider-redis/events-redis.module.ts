import { EVENTS } from "@podosoft/podokit-runtime";
import type { PodokitModule } from "../core/services";
import { PROVIDERS } from "../config/providers";
import { RedisEventBus } from "./redis-event.bus";

export const eventsRedisModule: PodokitModule = {
  name: "events-redis",
  configure: (_env, services): void => {
    if (PROVIDERS.events !== "redis") return;
    const events = new RedisEventBus();
    services.register(EVENTS, events, async () => {
      await events.close();
    });
    services.onStart(() => events.ready());
  },
};

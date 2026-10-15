import { CACHE, MemoryCacheStore } from "@podosoft/podokit-runtime";
import type { PodokitModule } from "../core/services";
import { PROVIDERS } from "../config/providers";

export const cacheMemoryModule: PodokitModule = {
  name: "cache-memory",
  configure: (_env, services): void => {
    if (PROVIDERS.cache !== "memory") return;
    const cache = new MemoryCacheStore();
    services.register(CACHE, cache, () => cache.close());
  },
};

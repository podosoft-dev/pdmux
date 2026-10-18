import type { PodokitModule, ServiceKey } from "../../core/services";

export const API_KEY_VERIFIER = Symbol("desktop-api-key-verifier") as ServiceKey<{ isValid(provided: string): boolean }>;

// The shared factory keeps its lifecycle and guards. These server-only modules
// resolve here at desktop build time, so their implementations are never loaded.
export const storageModule: PodokitModule = { name: "desktop-excluded-s3" };
export const redisModule: PodokitModule = { name: "desktop-excluded-redis" };
export const apiKeyModule: PodokitModule = { name: "desktop-excluded-api-keys", configure: (_env, services): void => { services.register(API_KEY_VERIFIER, { isValid: () => false }); } };
export const eventsRedisModule: PodokitModule = { name: "desktop-excluded-redis-events" };
export const jobsModule: PodokitModule = { name: "desktop-excluded-bullmq" };
export const loggingModule: PodokitModule = { name: "desktop-excluded-server-logs" };

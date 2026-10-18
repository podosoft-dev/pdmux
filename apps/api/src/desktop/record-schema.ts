import { z } from "zod";
const optionalText = z.string().max(1024).nullable();
export const serviceSchema = z.object({
  id: z.string().uuid(), label: z.string().trim().min(1).max(64), port: z.number().int().min(1).max(65535),
  probe: z.enum(["tcp", "http", "none"]), path: z.string().max(1024), urlTemplate: optionalText,
  sortOrder: z.number().int().min(0), enabled: z.boolean(),
}).strict();
export const rootSchema = z.object({ id: z.string().uuid(), path: z.string().min(1).max(1024), enabled: z.boolean(), sortOrder: z.number().int().min(0) }).strict();
export const hostSchema = z.object({
  label: z.string().trim().min(1).max(64), address: z.string().max(255).nullable(), description: z.string().max(512).nullable(),
  tags: z.array(z.string().max(32)).max(32), sortOrder: z.number().int().min(0), enabled: z.boolean(),
  services: z.array(serviceSchema).max(100), roots: z.array(rootSchema).max(100),
}).strict();
export const layoutSchema = z.object({ name: z.string().regex(/^[\w -]{1,64}$/), isDefault: z.boolean(), payload: z.record(z.unknown()) }).strict();
export const widgetsSchema = z.object({ hostKey: z.string().max(256), widgets: z.record(z.unknown()) }).strict();
export const appearanceSchema = z.object({ theme: z.enum(["light", "dark", "system"]), locale: z.enum(["en", "ko"]) }).strict();

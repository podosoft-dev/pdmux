import type adminEnglish from "./catalogs/admin-dashboard/en.json";
import type appEnglish from "./catalogs/app/en.json";

export interface LocaleDefinition {
  code: string;
  name: string;
  direction: "ltr" | "rtl";
  enabled: boolean;
}

type JsonObject = Record<string, unknown>;

export type ModuleMessages = {
  // Modules add their typed message namespaces here.
  // podokit:begin:message-types
  // podokit:end:message-types
};

export type Messages = typeof adminEnglish & typeof appEnglish & ModuleMessages;
export type Locale = string;

const definitionFiles = import.meta.glob<{ default: LocaleDefinition }>("./locales/*.json", {
  eager: true,
});
const catalogFiles = import.meta.glob<{ default: JsonObject }>("./catalogs/*/*.json");

function definitions(): LocaleDefinition[] {
  return Object.values(definitionFiles)
    .map((module) => module.default)
    .filter((definition) => definition.enabled)
    .sort((left, right) => left.code.localeCompare(right.code));
}

export const localeDefinitions = definitions();
export const LOCALES = localeDefinitions.map((definition) => definition.code);
export const defaultLocale: Locale = "en";
export const localeNames: Record<string, string> = Object.fromEntries(
  localeDefinitions.map((definition) => [definition.code, definition.name]),
);

export function resolveLocale(value: string | undefined | null): Locale {
  if (!value) return defaultLocale;
  const exact = localeDefinitions.find((definition) => definition.code === value);
  if (exact) return exact.code;
  const insensitive = localeDefinitions.find(
    (definition) => definition.code.toLowerCase() === value.toLowerCase(),
  );
  return insensitive?.code ?? defaultLocale;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeCatalog(target: JsonObject, source: JsonObject): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const previous = result[key];
    result[key] = isObject(previous) && isObject(value) ? mergeCatalog(previous, value) : value;
  }
  return result;
}

function catalogCode(path: string): string | null {
  const match = path.match(/\/([^/]+)\.json$/);
  return match?.[1] ?? null;
}

async function loadCatalog(code: string): Promise<JsonObject> {
  const paths = Object.keys(catalogFiles)
    .filter((path) => catalogCode(path) === code)
    .sort((left, right) => {
      const leftApp = left.includes("/app/") ? 1 : 0;
      const rightApp = right.includes("/app/") ? 1 : 0;
      return leftApp - rightApp || left.localeCompare(right);
    });
  let catalog: JsonObject = {};
  for (const path of paths) {
    const loader = catalogFiles[path];
    if (!loader) continue;
    catalog = mergeCatalog(catalog, (await loader()).default);
  }
  return catalog;
}

export async function loadMessages(
  locale: string,
  configuredFallback?: string | null,
): Promise<Messages> {
  const selected = resolveLocale(locale);
  const fallback = resolveLocale(configuredFallback);
  const candidates = [defaultLocale, fallback, selected];
  // A later catalog has higher priority. Keep the last occurrence so selecting
  // the built-in English fallback still overrides a non-English site default.
  const chain = candidates.filter((code, index) => candidates.lastIndexOf(code) === index);
  let catalog: JsonObject = {};
  for (const code of chain) catalog = mergeCatalog(catalog, await loadCatalog(code));
  return catalog as Messages;
}

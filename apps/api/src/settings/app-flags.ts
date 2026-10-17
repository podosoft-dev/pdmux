// This owned file is never overwritten by `podo update`. Declare the
// application's on/off settings and their defaults here. They are stored with
// PodoKit's feature flags in app_setting: administrators change them through
// PUT /account/settings, the API reads them with SettingsService.getBool(), and
// GET /account/capabilities returns them as `appFlags`, so do not put anything
// secret in a name. A missing row keeps the default.
//
// mcpEnabled is pdmux's MCP kill switch. It ships on because host-scoped MCP keys
// were in use before the switch existed; mcp/mcp-enabled.ts reads the stored row
// across replicas.
export const APP_FLAG_DEFAULTS = { mcpEnabled: true } satisfies Record<string, boolean>;

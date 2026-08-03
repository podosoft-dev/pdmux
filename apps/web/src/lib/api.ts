import { createApiClient } from "@podosoft/podokit-api-client";

// Browser client: same-origin. REST calls go to /api/* and auth to /api/auth/*,
// both proxied to the backend by the SvelteKit server (see routes/api/**).
export const api = createApiClient();

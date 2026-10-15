import { AppException } from "@podosoft/podokit-contracts";
import { objectResponse } from "@podosoft/podokit-runtime";
import { Elysia, t } from "elysia";
import type { ElysiaPlugin } from "../core/services";
import type { ProfileImageService } from "../profile-image/profile-image.service";
import type { SiteSettingsService } from "../site-settings/site-settings.service";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Pages link the favicon as `?v=<version>`, and a new upload changes the
 * version, so that URL can be cached for good. Any other URL revalidates.
 */
export function faviconCacheControl(current: string | null, requested: string | undefined): string {
  return current !== null && requested === current ? IMMUTABLE_CACHE_CONTROL : "no-cache";
}

/** Public images streamed from object storage with validators for 304 replies. */
export function siteAssetRoutes(
  site: Pick<SiteSettingsService, "getFavicon">,
  profileImages: Pick<ProfileImageService, "get">,
): ElysiaPlugin {
  return new Elysia({ name: "podokit.admin.site-assets" })
    .get("/site/favicon", async ({ request, query }) => {
      const icon = await site.getFavicon();
      if (!icon) throw new AppException("FAVICON_NOT_FOUND", "No favicon set", 404);
      return objectResponse(request, icon.object, {
        contentType: icon.contentType,
        cacheControl: faviconCacheControl(icon.version, query.v),
      });
    }, {
      query: t.Object({ v: t.Optional(t.String()) }),
      detail: {
        tags: ["site"],
        summary: "Get the site favicon",
        description: "Cached permanently when `v` is the current `faviconVersion`; revalidated otherwise.",
      },
    })
    .get("/profile-images/:fileName", async ({ request, params }) => {
      const image = await profileImages.get(params.fileName);
      // Every upload gets a new random file name, so a name never changes content.
      return objectResponse(request, image.object, {
        contentType: image.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
    }, {
      params: t.Object({ fileName: t.String({ minLength: 1 }) }),
      detail: { tags: ["account"], summary: "Get a public profile image" },
    });
}

import {
  AppException,
  PROFILE_IMAGE_REQUIRED,
  PROFILE_IMAGE_TOO_LARGE,
} from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import { AUTH } from "./auth/auth.module";
import {
  ACCESS_POLICY,
  DATABASE,
  LOGGER,
  type AppPlugin,
  type PodokitModule,
  type ServiceKey,
} from "./core/services";
import { ProfileImageService } from "./profile-image/profile-image.service";
import { PROFILE_IMAGE_POLICY } from "@podosoft/podokit-contracts";
import {
  PUBLIC_SITE_KEYS,
  SiteSettingsService,
} from "./site-settings/site-settings.service";
import { validateSiteSetting } from "./site-settings/site-settings.validation";
import { STORAGE } from "./storage/storage.module";

export const SITE_SETTINGS = Symbol("site-settings") as ServiceKey<SiteSettingsService>;
export const PROFILE_IMAGES = Symbol("profile-images") as ServiceKey<ProfileImageService>;

const ICON_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const MAX_ICON_BYTES = 1024 * 1024;

function currentImage(user: Record<string, unknown>): string | null {
  return typeof user.image === "string" ? user.image : null;
}

function responseBody(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const adminPlugin: AppPlugin = ({ services }) => {
  const auth = services.resolve(AUTH);
  const site = services.resolve(SITE_SETTINGS);
  const profileImages = services.resolve(PROFILE_IMAGES);

  return new Elysia({ name: "podokit.admin" })
    .get("/site/settings", async () => {
      const all = await site.getAll();
      const response: Record<string, string | boolean | null> = {};
      for (const key of PUBLIC_SITE_KEYS) response[key] = all[key] ?? null;
      response.hasFavicon = (await site.get("faviconContentType")) !== null;
      response.faviconVersion = await site.faviconVersion();
      return response;
    }, {
      detail: { tags: ["site"], summary: "Get public site settings" },
    })
    .put("/site/settings", async ({ request, body }) => {
      await auth.requireAdmin(request);
      const update: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        update[key] = validateSiteSetting(key, value);
      }
      return site.setMany(update);
    }, {
      body: t.Record(t.String(), t.String()),
      detail: { tags: ["site"], summary: "Update site settings" },
    })
    .post("/site/favicon", async ({ request, body, set }) => {
      await auth.requireAdmin(request);
      const file = body.file;
      if (file.size > MAX_ICON_BYTES) {
        throw new AppException("FAVICON_TOO_LARGE", "Icon must be 1 MB or smaller", 413);
      }
      if (!ICON_TYPES.has(file.type)) {
        throw new AppException("FAVICON_TYPE_INVALID", "Icon must be SVG, PNG, or ICO", 400);
      }
      await site.setFavicon(new Uint8Array(await file.arrayBuffer()), file.type);
      set.status = 201;
      return { version: await site.faviconVersion() };
    }, {
      body: t.Object({ file: t.File() }),
      detail: { tags: ["site"], summary: "Upload the site favicon" },
    })
    .get("/site/favicon", async () => {
      const icon = await site.getFavicon();
      if (!icon) throw new AppException("FAVICON_NOT_FOUND", "No favicon set", 404);
      return new Response(responseBody(icon.body), {
        headers: { "content-type": icon.contentType },
      });
    }, {
      detail: { tags: ["site"], summary: "Get the site favicon" },
    })
    .post("/account/profile-image", async ({ request, body, set }) => {
      const session = await auth.requireSession(request);
      const file = body.file;
      if (!file) {
        throw new AppException(PROFILE_IMAGE_REQUIRED, "A profile image file is required.", 400);
      }
      if (file.size > PROFILE_IMAGE_POLICY.maxBytes) {
        throw new AppException(PROFILE_IMAGE_TOO_LARGE, "Profile image must be 2 MB or smaller.", 413);
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await profileImages.upload(currentImage(session.user), {
        buffer,
        mimetype: file.type,
        size: file.size,
      }, request.headers);
      set.status = 201;
      return result;
    }, {
      body: t.Object({ file: t.File() }),
      detail: { tags: ["account"], summary: "Upload the current user's profile image" },
    })
    .delete("/account/profile-image", async ({ request }) => {
      const session = await auth.requireSession(request);
      return profileImages.remove(currentImage(session.user), request.headers);
    }, {
      detail: { tags: ["account"], summary: "Remove the current user's profile image" },
    })
    .get("/profile-images/:fileName", async ({ params, set }) => {
      const image = await profileImages.get(params.fileName);
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return new Response(responseBody(image.body), {
        headers: { "content-type": image.contentType },
      });
    }, {
      params: t.Object({ fileName: t.String({ minLength: 1 }) }),
      detail: { tags: ["account"], summary: "Get a public profile image" },
    });
};

export const adminModule: PodokitModule = {
  name: "admin-dashboard",
  configure: (_env, services): void => {
    const storage = services.resolve(STORAGE);
    const site = new SiteSettingsService(services.resolve(DATABASE).sql, storage);
    const profileImages = new ProfileImageService(storage, services.resolve(LOGGER));
    services.register(SITE_SETTINGS, site);
    services.register(PROFILE_IMAGES, profileImages, () => profileImages.close());
    services.onStart(() => profileImages.connect());
    const policy = services.resolve(ACCESS_POLICY);
    policy.register("GET", "/site/settings", "public");
    policy.register("GET", "/site/favicon", "public");
    policy.register("GET", "/profile-images/:fileName", "public");
  },
  plugin: adminPlugin,
};

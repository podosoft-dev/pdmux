import FileTextIcon from "@lucide/svelte/icons/file-text";
import { describe, expect, it, vi } from "vitest";
import { adminNavEntries } from "./nav";

// Stands in for the application's own entries in the app-owned app-nav.ts.
vi.mock("./app-nav", async () => {
  const { default: icon } = await import("@lucide/svelte/icons/file-text");
  return {
    APP_ADMIN_NAV: [
      { href: "/admin/specs", label: () => "Specs", icon, adminOnly: true },
      { href: "/admin/help", label: () => "Help", icon },
    ],
  };
});

// Stands in for the entries installed modules add to registry.svelte.ts, so the
// expected order does not depend on which modules an application installs.
vi.mock("./registry.svelte.js", async () => {
  const { default: icon } = await import("@lucide/svelte/icons/newspaper");
  return {
    moduleNavEntries: [
      { href: "/admin/blog", label: () => "Blog", icon, adminOnly: true },
      { href: "/admin/reports", label: () => "Reports", icon },
    ],
  };
});

describe("admin navigation", () => {
  it("places the application's entries, then module entries, before Settings", () => {
    const hrefs = adminNavEntries({ auditLog: true }, "admin").map((entry) => entry.href);

    expect(hrefs).toEqual([
      "/admin",
      "/admin/users",
      "/admin/sessions",
      "/admin/audit",
      "/admin/specs",
      "/admin/help",
      "/admin/blog",
      "/admin/reports",
      "/admin/settings",
    ]);
    expect(adminNavEntries(undefined, "admin").find((entry) => entry.href === "/admin/specs")?.icon).toBe(
      FileTextIcon,
    );
  });

  it("hides admin-only application and module entries from other roles", () => {
    const hrefs = adminNavEntries(undefined, "moderator").map((entry) => entry.href);

    expect(hrefs).toEqual(["/admin", "/admin/help", "/admin/reports"]);
  });
});

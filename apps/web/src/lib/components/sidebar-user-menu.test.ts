import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import SidebarUserMenu from "./sidebar-user-menu.svelte";

vi.mock("$app/state", () => ({
  page: {
    url: new URL("http://localhost/projects"),
    data: {
      locale: "en",
      messages: { nav: { account: "Account", signOut: "Sign out" }, common: { appName: "Admin" } },
    },
  },
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

describe("SidebarUserMenu", () => {
  it("renders the account menu in a shell without a sidebar", () => {
    const user = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", role: "user" };

    const { body } = render(SidebarUserMenu, { props: { user } });

    expect(body).toContain('data-testid="account-menu"');
    expect(body).not.toContain('data-testid="sidebar-user-menu"');
    expect(body).toContain("Ada Lovelace");
    expect(body).toContain("ada@example.com");
  });
});

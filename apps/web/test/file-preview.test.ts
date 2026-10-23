// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { relativeFilePath, renderMarkdown } from "../src/lib/dashboard/file-preview";

describe("[TC-PDFILE-016] Markdown is readable without executing file content", () => {
  const url = (path: string, inline: boolean): string => `/files?path=${encodeURIComponent(path)}&inline=${inline}`;
  it("renders headings, tables, tasks and escaped code, and resolves remote relative links", () => {
    const html = renderMarkdown('# Guide\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```html\n<script>x()</script>\n```\n\n[Next](sub/next.md)\n\n![Diagram](../image.png)', "docs/guide.md", url);
    const node = document.createElement("div"); node.innerHTML = html;
    expect(node.querySelector("h1")?.textContent).toBe("Guide");
    expect(node.querySelector("table td")?.textContent).toBe("1");
    expect(node.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect(node.querySelector("code")?.textContent).toContain("<script>");
    expect(node.querySelector("a")?.dataset.filePath).toBe("docs/sub/next.md");
    expect(node.querySelector("img")?.getAttribute("src")).toBe(url("image.png", true));
  });
  it("blocks raw HTML, unsafe URLs and paths outside the remote home", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n![bad](data:image/svg+xml,test)\n\n[escape](../../secret)\n\n[external](https://example.com)', "docs/readme.md", url);
    const node = document.createElement("div"); node.innerHTML = html;
    expect(node.querySelector("script,iframe,object,img")).toBeNull();
    expect(node.querySelectorAll("a")).toHaveLength(1);
    expect(node.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(html).not.toContain("javascript:");
    for (const ref of ["../../outside", "/etc/passwd", "%2e%2e/%2e%2e/secret", "file:///tmp/a", "a\\b", "%00"]) expect(relativeFilePath("docs/file.md", ref)).toBeNull();
    expect(relativeFilePath("docs/file.md", "../notes.md#part")).toBe("notes.md");
  });
});

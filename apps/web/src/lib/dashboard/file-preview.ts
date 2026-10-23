import { Marked } from "marked";
import DOMPurify from "dompurify";
import { previewableAs } from "@pdmux/core";

/** Resolve against the remote document, never against the application's origin. */
export function relativeFilePath(documentPath: string, reference: string): string | null {
  let input: string;
  try { input = decodeURIComponent(reference.split(/[?#]/)[0] ?? ""); } catch { return null; }
  if (!input || /[\\\u0000:]/.test(input) || input.startsWith("/")) return null;
  const parts = documentPath.split("/").slice(0, -1);
  for (const part of input.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || null;
}

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function external(value: string): string | null {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

/** Loaded only in a browser when a Markdown preview is opened. */
export function renderMarkdown(source: string, path: string, fileUrl: (path: string, inline: boolean) => string): string {
  const headings = new Map<string, number>();
  const parser = new Marked({ gfm: true, breaks: false, renderer: {
    html(): string { return ""; },
    heading({ tokens, depth, text }): string {
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
      const count = headings.get(slug) ?? 0; headings.set(slug, count + 1);
      return `<h${depth} id="${escape(slug + (count ? `-${count}` : ""))}">${this.parser.parseInline(tokens)}</h${depth}>`;
    },
    link({ href, tokens }): string {
      const label = this.parser.parseInline(tokens);
      if (href.startsWith("#")) return `<a href="${escape(href)}">${label}</a>`;
      const url = external(href);
      if (url) return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      const local = relativeFilePath(path, href);
      return local ? `<a href="${escape(fileUrl(local, false))}" data-file-path="${escape(local)}">${label}</a>` : label;
    },
    image({ href, text }): string {
      const local = relativeFilePath(path, href);
      const url = external(href) ?? (local && previewableAs(local.split("/").pop() ?? "") === "image" ? fileUrl(local, true) : null);
      return url ? `<img src="${escape(url)}" alt="${escape(text)}" loading="lazy" referrerpolicy="no-referrer">` : escape(text);
    },
  } });
  const html = parser.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "br", "strong", "em", "del", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "input"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "target", "rel", "type", "disabled", "checked", "start", "align", "loading", "referrerpolicy", "data-file-path"],
    ALLOW_DATA_ATTR: false,
  });
}

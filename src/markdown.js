import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false
});

export function renderMarkdownSafe(markdownText) {
  const raw = typeof markdownText === "string" ? markdownText : "";
  const html = marked.parse(raw);
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "h3", "h4", "h5", "h6"]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      '*': ["class"]
    },
    allowedSchemes: ["http", "https", "data"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" })
    }
  });
}

const DELIMITER_RE = /<!--|-->/g;

/**
 * Removes HTML comment delimiters until none are left. A single pass is not enough: removing one
 * can assemble another from the surrounding characters ("<!<!----" becomes "<!--").
 */
export function stripCommentDelimiters(text) {
  let current = String(text ?? "");
  for (;;) {
    const next = current.replace(DELIMITER_RE, "");
    if (next === current) return current;
    current = next;
  }
}

/** Text that ends up on a public pull request: drop markup that could hide or forge markers, defuse @mentions. */
export function sanitize(text, max) {
  const cleaned = stripCommentDelimiters(String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
  return cleaned.replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b").trim().slice(0, max);
}

/**
 * For text written by a model that read untrusted content: on top of `sanitize`, remove what could phone home
 * or impersonate (images, link targets, raw HTML) and flatten whitespace so it stays inside its list item.
 */
export function sanitizeModelText(text, max) {
  const flattened = String(text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ");
  return sanitize(flattened, max);
}

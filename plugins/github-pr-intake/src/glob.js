const cache = new Map();

/** Minimal glob: `**` crosses directories, `*` and `?` stay inside one path segment. */
export function globToRegExp(glob) {
  const cached = cache.get(glob);
  if (cached) return cached;
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const regexp = new RegExp(`^${source}$`);
  cache.set(glob, regexp);
  return regexp;
}

export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

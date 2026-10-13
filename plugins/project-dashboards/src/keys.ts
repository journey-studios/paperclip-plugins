/**
 * Spec-derived objects use author-controlled keys, so they must never be read
 * through the prototype chain or written through a prototype setter.
 */
export const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.includes(key);
}

/** Own-property read: returns undefined for inherited names such as "toString". */
export function getOwn<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (!map || !Object.hasOwn(map, key)) {
    return undefined;
  }
  return map[key];
}

/** Prototype-less dictionary: assigning "__proto__" creates a plain own key. */
export function dict<T>(): Record<string, T> {
  return Object.create(null);
}

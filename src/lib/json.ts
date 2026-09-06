/**
 * The schema stores structured payloads as JSON strings so it stays portable
 * between SQLite and PostgreSQL. These helpers keep that decision from leaking:
 * callers get typed values and never a parse error at runtime.
 */

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

import { readFile } from "node:fs/promises";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** `Array.isArray` alone narrows `unknown` to `any[]`. */
export function asItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type JsonFile =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok"; readonly value: unknown };

export function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Reads and parses one JSON file. Never throws: a bad file is a value the caller turns into a warning. */
export async function readJsonFile(path: string): Promise<JsonFile> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return isMissing(error)
      ? { kind: "missing" }
      : { kind: "invalid", reason: errorMessage(error) };
  }
  try {
    return { kind: "ok", value: JSON.parse(source) };
  } catch (error) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
}

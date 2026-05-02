import type { JsonValue } from "./types";

export function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

export function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

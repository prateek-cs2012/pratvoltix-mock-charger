import { createHash } from "node:crypto";
import { ReportError } from "./types.js";

export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeRunId(id: string): void {
  if (!SAFE_RUN_ID.test(id)) {
    throw new ReportError(
      `Run id "${id}" is not a safe artifact directory name. Use letters, digits, "_" and "-" only.`,
    );
  }
}

export function sha256Hex(contents: string): string {
  return createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex");
}

export function byteLength(contents: string): number {
  return Buffer.byteLength(contents, "utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    if (required) {
      throw new ReportError(`Run report is missing ${field}.`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ReportError(`${field} must be a non-empty string. Received ${preview(value)}.`);
  }
  return value;
}

export function readIso(record: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = readString(record, field, required);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ReportError(`${field} must be an ISO-8601 timestamp. Received "${value}".`);
  }
  return parsed.toISOString();
}

export function readInteger(record: Record<string, unknown>, field: string, minimum = 0): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ReportError(`${field} must be an integer greater than or equal to ${minimum}. Received ${preview(value)}.`);
  }
  return value;
}

export function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ReportError(`${field} must be an array of strings.`);
  }
  return [...value];
}

export function preview(value: unknown): string {
  if (typeof value === "string") {
    return `"${value.slice(0, 80)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return typeof value;
}

export function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return sorted;
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

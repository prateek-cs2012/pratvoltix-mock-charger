import type { ProfileParameterSpec, SelectionItem } from "../models";

export function formatWhen(value: string | null | undefined): { local: string; utc: string } {
  if (!value) {
    return { local: "Unknown", utc: "" };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { local: value, utc: "" };
  }
  const local = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date).replace(/\b(am|pm)\b/g, (part) => part.toUpperCase());
  return { local, utc: date.toISOString() };
}

export function formatDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  if (!startedAt || !finishedAt) {
    return "Unknown";
  }
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) {
    return "Unknown";
  }
  if (duration < 1000) {
    return `${duration} ms`;
  }
  return `${(duration / 1000).toFixed(1)} s`;
}

export function selectionBody(selection: SelectionItem[]): { caseIds: string[]; scenarioIds: string[]; suiteIds: string[] } {
  return {
    caseIds: selection.filter((item) => item.kind === "case").map((item) => item.id),
    scenarioIds: selection.filter((item) => item.kind === "scenario").map((item) => item.id),
    suiteIds: selection.filter((item) => item.kind === "suite").map((item) => item.id),
  };
}

export function typedOverrides(overrides: Record<string, string>, specs: ProfileParameterSpec[]): Record<string, string | number> {
  const typed: Record<string, string | number> = {};
  for (const [name, raw] of Object.entries(overrides)) {
    if (raw.length === 0) {
      continue;
    }
    const spec = specs.find((item) => item.name === name);
    if (spec?.type === "integer") {
      typed[name] = Number(raw);
    } else {
      typed[name] = raw;
    }
  }
  return typed;
}

export function localOverrideError(spec: ProfileParameterSpec, raw: string): string | null {
  if (raw.length === 0) {
    return null;
  }
  if (spec.type === "integer") {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      return `${spec.name} must be an integer${bounds(spec)}.`;
    }
    const value = Number(raw);
    if ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum)) {
      return `${spec.name} must be an integer${bounds(spec)}.`;
    }
    return null;
  }
  if (raw.trim().length === 0 || (spec.maxLength !== undefined && raw.length > spec.maxLength)) {
    return `${spec.name} must be a non-empty string${spec.maxLength ? ` of at most ${spec.maxLength} characters` : ""}.`;
  }
  return null;
}

function bounds(spec: ProfileParameterSpec): string {
  if (spec.minimum === undefined || spec.maximum === undefined) {
    return "";
  }
  return ` from ${spec.minimum} to ${spec.maximum}`;
}

export function matchesQuery(parts: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return parts.join("\n").toLowerCase().includes(needle);
}

export function traceNdjson(entries: Array<Record<string, unknown>>): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function safeDownloadName(runId: string, extension: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId) ? runId : "run";
  return `${safe}.${extension}`;
}

import { HttpError } from "./http-error.js";
import {
  EMPTY_TRACE_SUMMARY,
  TRACE_DIRECTIONS,
  TRACE_MESSAGE_TYPES,
  TRACE_PAGE_MAX,
  type TraceDirection,
  type TraceEntry,
  type TraceFilter,
  type TraceMessageType,
  type TracePageRequest,
  type TraceResponse,
  type TraceSummary,
} from "./trace-types.js";

export function readTraceFilter(query: Record<string, unknown>): TraceFilter {
  const filter: TraceFilter = {};
  const caseId = readString(query.caseId, "caseId");
  const action = readString(query.action, "action");
  const direction = readString(query.direction, "direction");
  const messageType = readString(query.messageType, "messageType");
  if (caseId !== undefined) {
    filter.caseId = caseId;
  }
  if (action !== undefined) {
    filter.action = action;
  }
  if (direction !== undefined) {
    if (!isDirection(direction)) {
      throw new HttpError(400, "direction must be csms-to-charge-point or charge-point-to-csms.");
    }
    filter.direction = direction;
  }
  if (messageType !== undefined) {
    if (!isMessageType(messageType)) {
      throw new HttpError(400, "messageType must be CALL, CALLRESULT, CALLERROR, or UNKNOWN.");
    }
    filter.messageType = messageType;
  }
  return filter;
}

export function readTracePage(query: Record<string, unknown>): TracePageRequest {
  const page: TracePageRequest = {};
  if (query.limit !== undefined) {
    page.limit = readBoundedInteger(query.limit, "limit", 1, TRACE_PAGE_MAX);
  }
  if (query.afterSequence !== undefined) {
    page.afterSequence = readBoundedInteger(query.afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
  }
  return page;
}

export function filterTraceEntries(entries: readonly TraceEntry[], filter: TraceFilter): TraceEntry[] {
  return entries.filter((entry) => {
    if (filter.caseId !== undefined && entry.caseId !== filter.caseId) {
      return false;
    }
    if (filter.action !== undefined && entry.action !== filter.action) {
      return false;
    }
    if (filter.direction !== undefined && entry.direction !== filter.direction) {
      return false;
    }
    if (filter.messageType !== undefined && entry.messageType !== filter.messageType) {
      return false;
    }
    return true;
  });
}

export function presentTrace(
  runId: string,
  trace: {
    summary?: TraceSummary | null;
    entries?: Iterable<LooseTraceEntry> | null;
  } | null | undefined,
  filter: TraceFilter = {},
  profile?: { schemaVersion: string; name: string },
  pageRequest: TracePageRequest = {},
): TraceResponse {
  const entries = trace?.entries ? [...trace.entries].map(copyEntry) : [];
  const filtered = filterTraceEntries(entries, filter).sort((left, right) => left.sequence - right.sequence);
  const after = pageRequest.afterSequence ?? -1;
  const remaining = filtered.filter((entry) => entry.sequence > after);
  const limit = pageRequest.limit ?? remaining.length;
  const slice = remaining.slice(0, limit);
  const hasMore = slice.length < remaining.length;
  return {
    runId,
    summary: summaryOf(trace?.summary ?? undefined),
    entries: slice,
    ...(profile ? { profile } : {}),
    page: {
      limit,
      returned: slice.length,
      nextAfterSequence: hasMore ? slice[slice.length - 1]?.sequence ?? null : null,
      hasMore,
    },
  };
}

export function presentTraceSummary(
  trace: { summary?: TraceSummary } | null | undefined,
): TraceSummary {
  return summaryOf(trace?.summary);
}

function summaryOf(summary: TraceSummary | undefined): TraceSummary {
  if (!summary) {
    return { ...EMPTY_TRACE_SUMMARY };
  }
  return {
    capturedEntries: summary.capturedEntries,
    droppedEntries: summary.droppedEntries,
    truncatedEntries: summary.truncatedEntries,
    truncated: summary.truncated,
  };
}

interface LooseTraceEntry {
  sequence: number;
  at: string;
  direction: TraceDirection;
  messageType: TraceMessageType;
  uniqueId?: string | null;
  action?: string | null;
  payload?: unknown;
  errorCode?: string | null;
  errorDescription?: string | null;
  raw?: string | null;
  caseId?: string | null;
  originalRawBytes?: number | null;
  originalPayloadBytes?: number | null;
}

function copyEntry(entry: LooseTraceEntry): TraceEntry {
  const copy: TraceEntry = {
    sequence: entry.sequence,
    at: entry.at,
    direction: entry.direction,
    messageType: entry.messageType,
  };
  assignCopy(copy, "uniqueId", entry.uniqueId);
  assignCopy(copy, "action", entry.action);
  assignCopy(copy, "errorCode", entry.errorCode);
  assignCopy(copy, "errorDescription", entry.errorDescription);
  assignCopy(copy, "raw", entry.raw);
  assignCopy(copy, "caseId", entry.caseId);
  if (entry.payload !== undefined && entry.payload !== null) {
    copy.payload = entry.payload;
  }
  if (typeof entry.originalRawBytes === "number") {
    copy.originalRawBytes = entry.originalRawBytes;
  }
  if (typeof entry.originalPayloadBytes === "number") {
    copy.originalPayloadBytes = entry.originalPayloadBytes;
  }
  return copy;
}

function assignCopy(
  entry: TraceEntry,
  key: "uniqueId" | "action" | "errorCode" | "errorDescription" | "raw" | "caseId",
  value: string | null | undefined,
): void {
  if (typeof value === "string") {
    entry[key] = value;
  }
}

function readString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty string.`);
  }
  return value;
}

function readBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpError(400, `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function isDirection(value: string): value is TraceDirection {
  return (TRACE_DIRECTIONS as readonly string[]).includes(value);
}

function isMessageType(value: string): value is TraceMessageType {
  return (TRACE_MESSAGE_TYPES as readonly string[]).includes(value);
}

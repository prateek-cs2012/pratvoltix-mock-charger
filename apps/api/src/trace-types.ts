export const TRACE_DIRECTIONS = ["csms-to-charge-point", "charge-point-to-csms"] as const;
export const TRACE_MESSAGE_TYPES = ["CALL", "CALLRESULT", "CALLERROR", "UNKNOWN"] as const;

export type TraceDirection = (typeof TRACE_DIRECTIONS)[number];
export type TraceMessageType = (typeof TRACE_MESSAGE_TYPES)[number];

export interface TraceSummary {
  capturedEntries: number;
  droppedEntries: number;
  truncatedEntries: number;
  truncated: boolean;
}

export interface TraceEntry {
  sequence: number;
  at: string;
  direction: TraceDirection;
  messageType: TraceMessageType;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
  raw?: string;
  caseId?: string;
  /** Wire size of the frame when the stored raw text was shortened. */
  originalRawBytes?: number;
  /** Serialized payload size when the stored payload was shortened. */
  originalPayloadBytes?: number;
}

export interface StoredTrace {
  summary: TraceSummary;
  entries: TraceEntry[];
}

export interface TraceFilter {
  caseId?: string;
  action?: string;
  direction?: TraceDirection;
  messageType?: TraceMessageType;
}

export interface TracePageRequest {
  limit?: number;
  afterSequence?: number;
}

export const TRACE_PAGE_MAX = 500;

export interface TraceResponse {
  runId: string;
  summary: TraceSummary;
  entries: TraceEntry[];
  profile?: {
    schemaVersion: string;
    name: string;
  };
  page: TracePage;
}

export interface TracePage {
  limit: number;
  returned: number;
  nextAfterSequence: number | null;
  hasMore: boolean;
}

export const EMPTY_TRACE_SUMMARY: TraceSummary = {
  capturedEntries: 0,
  droppedEntries: 0,
  truncatedEntries: 0,
  truncated: false,
};

export interface TraceLimits {
  maxEntries: number;
  maxRawBytes: number;
  maxTranscriptBytes: number;
}

/** MongoDB documents are limited to 16 MiB. These caps keep one run well under that. */
export const DEFAULT_TRACE_LIMITS: TraceLimits = {
  maxEntries: 2_000,
  maxRawBytes: 64 * 1024,
  maxTranscriptBytes: 4 * 1024 * 1024,
};

/**
 * Parsed frames smaller than this keep a redacted raw copy beside the payload.
 * Larger payloads are stored once so MeterValues are not duplicated.
 */
export const RAW_DUPLICATE_THRESHOLD_BYTES = 1024;

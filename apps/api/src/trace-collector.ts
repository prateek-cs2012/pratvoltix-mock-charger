import type { OcppFrameObserver, OcppObservedFrame } from "@pratvoltix/ocpp";
import { redactRaw, redactValue } from "./trace-redact.js";
import {
  DEFAULT_TRACE_LIMITS,
  RAW_DUPLICATE_THRESHOLD_BYTES,
  type StoredTrace,
  type TraceDirection,
  type TraceEntry,
  type TraceLimits,
  type TraceSummary,
} from "./trace-types.js";

export interface FrameSource {
  observe(observer: OcppFrameObserver): () => void;
}

export class RunTraceCollector {
  private readonly entries: TraceEntry[] = [];
  private droppedEntries = 0;
  private truncatedEntries = 0;
  private transcriptBytes = 0;
  private sequence = 0;
  private activeCaseId: string | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly source: FrameSource,
    private readonly limits: TraceLimits = DEFAULT_TRACE_LIMITS,
  ) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.source.observe((frame) => {
      try {
        this.record(frame);
      } catch {
        this.droppedEntries += 1;
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  setActiveCase(caseId: string | undefined): void {
    this.activeCaseId = caseId;
  }

  snapshot(): StoredTrace {
    return {
      summary: this.summary(),
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }

  private summary(): TraceSummary {
    return {
      capturedEntries: this.entries.length,
      droppedEntries: this.droppedEntries,
      truncatedEntries: this.truncatedEntries,
      truncated: this.droppedEntries > 0 || this.truncatedEntries > 0,
    };
  }

  private record(frame: OcppObservedFrame): void {
    if (this.entries.length >= this.limits.maxEntries) {
      this.droppedEntries += 1;
      return;
    }
    const entry = this.toEntry(frame);
    entry.sequence = this.sequence + 1;
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (this.transcriptBytes + size > this.limits.maxTranscriptBytes) {
      this.droppedEntries += 1;
      return;
    }
    this.sequence = entry.sequence;
    this.entries.push(entry);
    this.transcriptBytes += size;
    if (entry.originalRawBytes !== undefined || entry.originalPayloadBytes !== undefined) {
      this.truncatedEntries += 1;
    }
  }

  private toEntry(frame: OcppObservedFrame): TraceEntry {
    const direction: TraceDirection =
      frame.direction === "inbound" ? "charge-point-to-csms" : "csms-to-charge-point";
    const entry: TraceEntry = {
      sequence: 0,
      at: new Date().toISOString(),
      direction,
      messageType: frame.messageType,
    };
    assign(entry, "uniqueId", frame.uniqueId);
    assign(entry, "action", frame.action);
    assign(entry, "errorCode", frame.errorCode);
    assign(entry, "errorDescription", frame.errorDescription);
    assign(entry, "caseId", this.activeCaseId);

    if (frame.payload !== undefined) {
      const redacted = redactValue(frame.payload);
      const payloadJson = JSON.stringify(redacted);
      const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
      if (payloadBytes > this.limits.maxRawBytes) {
        entry.payload = truncateUtf8(payloadJson, this.limits.maxRawBytes);
        entry.originalPayloadBytes = payloadBytes;
      } else {
        entry.payload = redacted;
      }
    }

    const payloadSize =
      entry.payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(entry.payload), "utf8");
    const keepRaw = frame.messageType === "UNKNOWN" || payloadSize <= RAW_DUPLICATE_THRESHOLD_BYTES;
    if (keepRaw) {
      const redactedRaw = redactRaw(frame.raw);
      const rawBytes = Buffer.byteLength(redactedRaw, "utf8");
      if (rawBytes > this.limits.maxRawBytes) {
        entry.raw = truncateUtf8(redactedRaw, this.limits.maxRawBytes);
        entry.originalRawBytes = Buffer.byteLength(frame.raw, "utf8");
      } else {
        entry.raw = redactedRaw;
      }
    }

    return entry;
  }
}

function assign<K extends "uniqueId" | "action" | "errorCode" | "errorDescription" | "caseId">(
  entry: TraceEntry,
  key: K,
  value: string | undefined,
): void {
  if (value !== undefined) {
    entry[key] = value;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end > 0) {
    const lead = buffer[end - 1]!;
    const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (maxBytes - (end - 1) < needed) {
      end -= 1;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}

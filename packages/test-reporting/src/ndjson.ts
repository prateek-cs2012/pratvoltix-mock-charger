import type { ReportTrace, ReportTraceEntry } from "./types.js";

export function renderNdjson(trace: ReportTrace): string {
  if (trace.entries.length === 0) {
    return "";
  }
  return `${trace.entries.map((entry) => JSON.stringify(orderedEntry(entry))).join("\n")}\n`;
}

function orderedEntry(entry: ReportTraceEntry): ReportTraceEntry {
  const ordered: ReportTraceEntry = {
    sequence: entry.sequence,
    at: entry.at,
    direction: entry.direction,
    messageType: entry.messageType,
  };
  if (entry.uniqueId !== undefined) {
    ordered.uniqueId = entry.uniqueId;
  }
  if (entry.action !== undefined) {
    ordered.action = entry.action;
  }
  if (entry.payload !== undefined) {
    ordered.payload = entry.payload;
  }
  if (entry.errorCode !== undefined) {
    ordered.errorCode = entry.errorCode;
  }
  if (entry.errorDescription !== undefined) {
    ordered.errorDescription = entry.errorDescription;
  }
  if (entry.raw !== undefined) {
    ordered.raw = entry.raw;
  }
  if (entry.caseId !== undefined) {
    ordered.caseId = entry.caseId;
  }
  if (entry.originalRawBytes !== undefined) {
    ordered.originalRawBytes = entry.originalRawBytes;
  }
  if (entry.originalPayloadBytes !== undefined) {
    ordered.originalPayloadBytes = entry.originalPayloadBytes;
  }
  return ordered;
}

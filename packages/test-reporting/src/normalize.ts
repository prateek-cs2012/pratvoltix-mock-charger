import {
  readInteger,
  readIso,
  readString,
  readStringArray,
  isRecord,
  sortedRecord,
} from "./text.js";
import {
  ReportError,
  type ReportOrigin,
  type ReportPlanCase,
  type ReportProfile,
  type ReportRun,
  type ReportSelection,
  type ReportTrace,
  type ReportTraceEntry,
  type ReportTarget,
  type ReportTraceSummary,
} from "./types.js";

const TERMINAL = new Set(["passed", "failed", "error"]);
const DIRECTIONS = new Set(["csms-to-charge-point", "charge-point-to-csms"]);
const MESSAGE_TYPES = new Set(["CALL", "CALLRESULT", "CALLERROR", "UNKNOWN"]);
const ORIGIN_TYPES = new Set(["case", "scenario", "suite"]);

export function normalizeRun(value: unknown): ReportRun {
  if (!isRecord(value)) {
    throw new ReportError("Run report must be a JSON object.");
  }
  const id = readString(value, "id") ?? "";
  const chargePointIdentity = readString(value, "chargePointIdentity") ?? "";
  const status = readString(value, "status") ?? "";
  if (!TERMINAL.has(status)) {
    throw new ReportError(`Run status must be passed, failed, or error. Received "${status}".`);
  }
  const createdAt = readIso(value, "createdAt") ?? "";
  const startedAt = readIso(value, "startedAt", false);
  const finishedAt = readIso(value, "finishedAt", false);
  let durationMs: number | undefined;
  if (startedAt && finishedAt) {
    durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    if (durationMs < 0) {
      throw new ReportError("finishedAt is earlier than startedAt.");
    }
  }
  const selection = readSelection(value.selection);
  const plan = readPlan(value.plan);
  const profile = readProfile(value.profile);
  const summary = readSummary(value.summary);
  const results = readResults(value.results);
  if (summary.total !== results.length) {
    throw new ReportError(`summary.total is ${summary.total} but the report has ${results.length} results.`);
  }
  const counted = {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    error: results.filter((result) => result.status === "error").length,
  };
  for (const key of ["passed", "failed", "error"] as const) {
    if (summary[key] !== counted[key]) {
      throw new ReportError(`summary.${key} is ${summary[key]} but ${counted[key]} results have that status.`);
    }
  }
  const traceSummary = value.trace === undefined || value.trace === null
    ? emptyTrace()
    : readTraceSummary(value.trace);
  const run: ReportRun = {
    id,
    chargePointIdentity,
    status: status as ReportRun["status"],
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    selection,
    plan,
    profile,
    summary,
    results,
    traceSummary,
    ...(readTarget(value.target) ? { target: readTarget(value.target) } : {}),
  };
  return run;
}

export function normalizeTrace(value: unknown, runId: string): ReportTrace {
  if (!isRecord(value)) {
    throw new ReportError("Trace response must be a JSON object.");
  }
  const summary = readTraceSummary(value.summary ?? value);
  if (!Array.isArray(value.entries)) {
    throw new ReportError("Trace entries must be an array.");
  }
  const entries = value.entries.map((entry, index) => readEntry(entry, index));
  return { runId, summary, entries };
}

export function emptyTrace(): ReportTraceSummary {
  return { capturedEntries: 0, droppedEntries: 0, truncatedEntries: 0, truncated: false };
}

function readTarget(value: unknown): ReportTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mode = readString(value, "mode");
  const configurationSource = readString(value, "configurationSource");
  const urlTemplate = readString(value, "urlTemplate");
  const resolvedEndpoint = readString(value, "resolvedEndpoint");
  const stationIdentity = readString(value, "stationIdentity");
  const requestedSubprotocol = readString(value, "requestedSubprotocol");
  if (mode !== "embedded" && mode !== "external") {
    return undefined;
  }
  if (configurationSource !== "run" && configurationSource !== "environment" && configurationSource !== "default") {
    return undefined;
  }
  if (!urlTemplate || !resolvedEndpoint || !stationIdentity || !requestedSubprotocol) {
    return undefined;
  }
  const negotiated = value.negotiatedSubprotocol;
  return {
    mode,
    configurationSource,
    urlTemplate: redactTargetUrl(urlTemplate),
    resolvedEndpoint: redactTargetUrl(resolvedEndpoint),
    stationIdentity,
    requestedSubprotocol,
    negotiatedSubprotocol: typeof negotiated === "string" ? negotiated : null,
  };
}

function redactTargetUrl(value: string): string {
  const token = "___STATION___";
  const substituted = value.replaceAll("{stationId}", token);
  try {
    const url = new URL(substituted);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "redacted");
    }
    return url.toString().replaceAll(token, "{stationId}");
  } catch {
    return "invalid-url";
  }
}

function readSelection(value: unknown): ReportSelection | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ReportError("selection must be an object or null.");
  }
  return {
    caseIds: readStringArray(value.caseIds ?? [], "selection.caseIds"),
    scenarioIds: readStringArray(value.scenarioIds ?? [], "selection.scenarioIds"),
    suiteIds: readStringArray(value.suiteIds ?? [], "selection.suiteIds"),
  };
}

function readPlan(value: unknown): ReportRun["plan"] {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ReportError("plan must be an object or null.");
  }
  const catalogVersion = readString(value, "catalogVersion") ?? "";
  if (!Array.isArray(value.cases)) {
    throw new ReportError("plan.cases must be an array.");
  }
  return {
    catalogVersion,
    cases: value.cases.map((item, index) => readPlanCase(item, index)),
  };
}

function readPlanCase(value: unknown, index: number): ReportPlanCase {
  if (!isRecord(value)) {
    throw new ReportError(`plan.cases[${index}] must be an object.`);
  }
  const requirements = value.requirements === undefined ? undefined : readStringArray(value.requirements, `plan.cases[${index}].requirements`);
  if (!Array.isArray(value.origins)) {
    throw new ReportError(`plan.cases[${index}].origins must be an array.`);
  }
  const planCase: ReportPlanCase = {
    id: readString(value, "id") ?? "",
    title: readString(value, "title") ?? "",
    description: readString(value, "description") ?? "",
    version: readString(value, "version") ?? "",
    tags: readStringArray(value.tags ?? [], `plan.cases[${index}].tags`),
    timeoutMs: readInteger(value, "timeoutMs"),
    origins: value.origins.map((origin, originIndex) => readOrigin(origin, index, originIndex)),
  };
  if (requirements && requirements.length > 0) {
    planCase.requirements = requirements;
  }
  return planCase;
}

function readOrigin(value: unknown, caseIndex: number, originIndex: number): ReportOrigin {
  if (!isRecord(value)) {
    throw new ReportError(`plan.cases[${caseIndex}].origins[${originIndex}] must be an object.`);
  }
  const type = readString(value, "type") ?? "";
  if (!ORIGIN_TYPES.has(type)) {
    throw new ReportError(`origin type must be case, scenario, or suite. Received "${type}".`);
  }
  return {
    type: type as ReportOrigin["type"],
    id: readString(value, "id") ?? "",
    title: readString(value, "title") ?? "",
  };
}

function readProfile(value: unknown): ReportProfile | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ReportError("profile must be an object or null.");
  }
  const schemaVersion = readString(value, "schemaVersion") ?? "";
  const name = readString(value, "name", false);
  if (!isRecord(value.parameters)) {
    throw new ReportError("profile.parameters must be an object.");
  }
  return {
    schemaVersion,
    ...(name ? { name } : {}),
    parameters: sortedRecord(value.parameters),
  };
}

function readSummary(value: unknown): ReportRun["summary"] {
  if (!isRecord(value)) {
    throw new ReportError("summary must be an object.");
  }
  return {
    total: readInteger(value, "total"),
    passed: readInteger(value, "passed"),
    failed: readInteger(value, "failed"),
    error: readInteger(value, "error"),
  };
}

function readResults(value: unknown): ReportRun["results"] {
  if (!Array.isArray(value)) {
    throw new ReportError("results must be an array.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ReportError(`results[${index}] must be an object.`);
    }
    const status = readString(item, "status") ?? "";
    if (!TERMINAL.has(status)) {
      throw new ReportError(`results[${index}].status must be passed, failed, or error. Received "${status}".`);
    }
    const error = readString(item, "error", false);
    if (!Array.isArray(item.logs)) {
      throw new ReportError(`results[${index}].logs must be an array.`);
    }
    return {
      id: readString(item, "id") ?? "",
      title: readString(item, "title") ?? "",
      status: status as ReportRun["results"][number]["status"],
      durationMs: readInteger(item, "durationMs"),
      ...(error ? { error } : {}),
      logs: item.logs.map((log, logIndex) => {
        if (!isRecord(log)) {
          throw new ReportError(`results[${index}].logs[${logIndex}] must be an object.`);
        }
        const level = readString(log, "level") ?? "";
        if (level !== "info" && level !== "error") {
          throw new ReportError(`log level must be info or error. Received "${level}".`);
        }
        if (typeof log.message !== "string") {
          throw new ReportError(`results[${index}].logs[${logIndex}].message must be a string.`);
        }
        return {
          level: level as "info" | "error",
          message: log.message,
          at: readIso(log, "at") ?? "",
        };
      }),
    };
  });
}

export function readTraceSummary(value: unknown): ReportTraceSummary {
  const record = isRecord(value) && isRecord(value.summary) ? value.summary : value;
  if (!isRecord(record)) {
    throw new ReportError("trace summary must be an object.");
  }
  const truncated = record.truncated;
  if (typeof truncated !== "boolean") {
    throw new ReportError(`trace.truncated must be a boolean. Received ${typeof truncated}.`);
  }
  return {
    capturedEntries: readInteger(record, "capturedEntries"),
    droppedEntries: readInteger(record, "droppedEntries"),
    truncatedEntries: readInteger(record, "truncatedEntries"),
    truncated,
  };
}

function readEntry(value: unknown, index: number): ReportTraceEntry {
  if (!isRecord(value)) {
    throw new ReportError(`trace.entries[${index}] must be an object.`);
  }
  const direction = readString(value, "direction") ?? "";
  const messageType = readString(value, "messageType") ?? "";
  if (!DIRECTIONS.has(direction)) {
    throw new ReportError(`trace.entries[${index}].direction is invalid. Received "${direction}".`);
  }
  if (!MESSAGE_TYPES.has(messageType)) {
    throw new ReportError(`trace.entries[${index}].messageType is invalid. Received "${messageType}".`);
  }
  const entry: ReportTraceEntry = {
    sequence: readInteger(value, "sequence"),
    at: readIso(value, "at") ?? "",
    direction: direction as ReportTraceEntry["direction"],
    messageType: messageType as ReportTraceEntry["messageType"],
  };
  assignOptionalString(entry, "uniqueId", value.uniqueId);
  assignOptionalString(entry, "action", value.action);
  if (value.payload !== undefined) {
    entry.payload = value.payload;
  }
  assignOptionalString(entry, "errorCode", value.errorCode);
  assignOptionalString(entry, "errorDescription", value.errorDescription);
  assignOptionalString(entry, "raw", value.raw);
  assignOptionalString(entry, "caseId", value.caseId);
  if (value.originalRawBytes !== undefined) {
    entry.originalRawBytes = readInteger(value, "originalRawBytes");
  }
  if (value.originalPayloadBytes !== undefined) {
    entry.originalPayloadBytes = readInteger(value, "originalPayloadBytes");
  }
  return entry;
}

function assignOptionalString(entry: ReportTraceEntry, key: "uniqueId" | "action" | "errorCode" | "errorDescription" | "raw" | "caseId", value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    throw new ReportError(`trace entry ${key} must be a string.`);
  }
  entry[key] = value;
}

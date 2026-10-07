export const REPORT_GENERATOR = {
  name: "@pratvoltix/test-reporting",
  version: "0.1.0",
} as const;

export const MANIFEST_SCHEMA_VERSION = "1" as const;

export const ARTIFACT_NAMES = [
  "junit.xml",
  "manifest.json",
  "run.json",
  "summary.txt",
  "trace-summary.json",
  "trace.ndjson",
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export interface ReportLog {
  level: "info" | "error";
  message: string;
  at: string;
}

export interface ReportResult {
  id: string;
  title: string;
  status: "passed" | "failed" | "error";
  durationMs: number;
  error?: string;
  logs: ReportLog[];
}

export interface ReportOrigin {
  type: "case" | "scenario" | "suite";
  id: string;
  title: string;
}

export interface ReportPlanCase {
  id: string;
  title: string;
  description: string;
  version: string;
  tags: string[];
  timeoutMs: number;
  requirements?: string[];
  origins: ReportOrigin[];
}

export interface ReportSelection {
  caseIds: string[];
  scenarioIds: string[];
  suiteIds: string[];
}

export interface ReportProfile {
  schemaVersion: string;
  name?: string;
  parameters: Record<string, unknown>;
}

export interface ReportTarget {
  mode: "embedded" | "external";
  configurationSource: "run" | "environment" | "default";
  urlTemplate: string;
  resolvedEndpoint: string;
  stationIdentity: string;
  requestedSubprotocol: string;
  negotiatedSubprotocol: string | null;
}

export interface ReportTraceSummary {
  capturedEntries: number;
  droppedEntries: number;
  truncatedEntries: number;
  truncated: boolean;
}

export interface ReportRun {
  id: string;
  chargePointIdentity: string;
  status: "passed" | "failed" | "error";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  selection: ReportSelection | null;
  plan: {
    catalogVersion: string;
    cases: ReportPlanCase[];
  } | null;
  profile: ReportProfile | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    error: number;
  };
  results: ReportResult[];
  traceSummary: ReportTraceSummary;
  target?: ReportTarget;
}

export interface ReportTraceEntry {
  sequence: number;
  at: string;
  direction: "csms-to-charge-point" | "charge-point-to-csms";
  messageType: "CALL" | "CALLRESULT" | "CALLERROR" | "UNKNOWN";
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
  raw?: string;
  caseId?: string;
  originalRawBytes?: number;
  originalPayloadBytes?: number;
}

export interface ReportTrace {
  runId: string;
  summary: ReportTraceSummary;
  entries: ReportTraceEntry[];
}

export interface RenderedArtifact {
  name: ArtifactName;
  mediaType: string;
  contents: string;
}

export interface TracePolicy {
  requireTrace: boolean;
  failOnTruncatedTrace: boolean;
  passed: boolean;
  reason?: string;
}

export interface ArtifactManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
  };
  run: {
    id: string;
    station: string;
    status: string;
    catalogVersion?: string;
    profileName?: string;
    profileSchemaVersion?: string;
  };
  traceExport: "complete" | "not-requested";
  tracePolicy?: TracePolicy;
  artifacts: Array<{
    name: string;
    mediaType: string;
    bytes: number;
    sha256: string;
  }>;
}

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

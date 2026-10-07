export interface ChargePoint {
  identity: string;
  ocppVersion: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  status: "connected" | "disconnected";
  connectorStatus: string | null;
  lastSeenAt: string | null;
  lastBootAt: string | null;
  heartbeatInterval: number | null;
  activeTransactionId: number | null;
}

export interface SimulatorStatus {
  identity: string;
  connected: boolean;
  protocolVersion: string;
  simulatorName: string;
  simulatorVersion: string;
  capabilities: string[];
  connectedAt: string | null;
  lastSeenAt: string | null;
  activeFaults: Array<{ id: string; action: string; effectType: string }>;
  lastCleanup: { ok: boolean; at: string; error?: string } | null;
}

export interface LabSettings {
  websocketBaseUrl: string;
  ocppVersion: string;
  subprotocol: string;
}

export interface HealthStatus {
  status: string;
  service: string;
  database: string;
}

export interface ProfileParameterSpec {
  name: string;
  type: "integer" | "string";
  description: string;
  persisted: boolean;
  default: number | string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface ProfileCatalog {
  schemaVersions: string[];
  nonSecret: boolean;
  notice: string;
  parameters: ProfileParameterSpec[];
}

export interface CatalogCase {
  id: string;
  title: string;
  description: string;
  version: string;
  tags: string[];
  requirements: string[];
  timeoutMs: number;
}

export interface CatalogScenario extends CatalogCase {
  caseIds: string[];
}

export interface CatalogSuite extends CatalogScenario {
  scenarioIds: string[];
}

export interface CatalogDocument {
  version: string;
  cases: CatalogCase[];
  scenarios: CatalogScenario[];
  suites: CatalogSuite[];
  profile: ProfileCatalog;
}

export interface PlanOrigin {
  type: "case" | "scenario" | "suite";
  id: string;
  title: string;
}

export interface PlannedCase {
  id: string;
  title: string;
  description: string;
  version: string;
  tags: string[];
  requirements: string[];
  timeoutMs: number;
  origins: PlanOrigin[];
}

export interface RunPreview {
  station: {
    identity: string;
    connected: boolean;
    simulatorConnected?: boolean;
    ocppVersion: string;
    capabilities: string[];
  };
  selection: { caseIds: string[]; scenarioIds: string[]; suiteIds: string[] };
  plan: { catalogVersion: string; cases: PlannedCase[] };
  effectiveProfile: {
    schemaVersion: string;
    name: string;
    overridden: string[];
    parameters: Record<string, string | number>;
  };
  compatibility: {
    compatible: boolean;
    missingCapabilities: Array<{ capability: string; caseIds: string[] }>;
  };
  estimatedTimeoutMs: number;
  target?: CsmsTargetSnapshot;
}

export interface CsmsTargetSnapshot {
  mode: "embedded" | "external";
  configurationSource: "run" | "environment" | "default";
  urlTemplate: string;
  resolvedEndpoint: string;
  stationIdentity: string;
  requestedSubprotocol: string;
  negotiatedSubprotocol: string | null;
}

export interface TestLog {
  level: "info" | "error";
  message: string;
  at: string;
}

export interface TestCaseResult {
  id: string;
  title: string;
  status: "passed" | "failed" | "error";
  durationMs: number;
  error?: string;
  logs: TestLog[];
}

export interface StoredPlanCase extends PlannedCase {}

export interface TestRun {
  id: string;
  chargePointIdentity: string;
  caseIds: string[];
  status: "queued" | "running" | "passed" | "failed" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  selection?: { caseIds: string[]; scenarioIds: string[]; suiteIds: string[] } | null;
  plan?: { catalogVersion: string; cases: StoredPlanCase[] } | null;
  summary: { total: number; passed: number; failed: number; error: number };
  results: TestCaseResult[];
  trace?: {
    capturedEntries: number;
    droppedEntries: number;
    truncatedEntries: number;
    truncated: boolean;
  };
  target?: CsmsTargetSnapshot;
  profile?: {
    schemaVersion: string;
    name: string;
    stored?: boolean;
    overridden?: string[];
    parameters?: Record<string, string | number>;
  };
}

export interface TraceEntry {
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

export interface TracePage {
  runId: string;
  summary: {
    capturedEntries: number;
    droppedEntries: number;
    truncatedEntries: number;
    truncated: boolean;
  };
  entries: TraceEntry[];
  profile?: { schemaVersion: string; name: string };
  page?: {
    limit: number;
    returned: number;
    nextAfterSequence: number | null;
    hasMore: boolean;
  };
}

export type SelectionKind = "case" | "scenario" | "suite";

export interface SelectionItem {
  kind: SelectionKind;
  id: string;
  title: string;
}

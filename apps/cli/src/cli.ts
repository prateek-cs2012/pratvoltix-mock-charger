import { readFileSync } from "node:fs";
import path from "node:path";
import {
  defaultOcppRunProfile,
  describeCatalog,
  parseProfileOverride,
  resolveOcppRunProfile,
} from "@pratvoltix/test-cases";
import { renderBundle, ReportError } from "@pratvoltix/test-reporting";
import { CliError, exitCodeForCi, exitCodeForRun, helpText, parseArgs, type ParsedCommand } from "./args.js";
import { writeArtifacts } from "./export.js";

export interface CliIo {
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env?: NodeJS.ProcessEnv;
}

interface RunView {
  id: string;
  chargePointIdentity: string;
  status: string;
  profile?: { schemaVersion: string; name: string; parameters?: Record<string, unknown> };
  summary?: { passed: number; failed: number; error: number; total: number };
  results?: Array<{ id: string; title: string; status: string; error?: string }>;
}

interface TraceView {
  runId: string;
  profile?: { schemaVersion: string; name: string };
  summary: {
    capturedEntries: number;
    droppedEntries: number;
    truncatedEntries: number;
    truncated: boolean;
  };
  entries: TraceEntryView[];
  page?: {
    limit: number;
    returned: number;
    nextAfterSequence: number | null;
    hasMore: boolean;
  };
}

interface TraceEntryView {
  sequence: number;
  at: string;
  direction: string;
  messageType: string;
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

interface CatalogView {
  version: string;
  cases: Array<{ id: string; title: string; tags: string[] }>;
  scenarios: Array<{ id: string; title: string; tags: string[] }>;
  suites: Array<{ id: string; title: string; tags: string[] }>;
}

interface SimulatorView {
  identity: string;
  connected: boolean;
  protocolVersion: string;
  simulatorName: string;
  simulatorVersion: string;
  capabilities: string[];
  activeFaults: unknown[];
  lastCleanup: { ok: boolean } | null;
}

const defaultIo: CliIo = {
  fetch: globalThis.fetch,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export async function executeCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const command = parseArgs(argv, io.env ?? process.env);
    if (command.kind === "help") {
      io.stdout(helpText());
      return 0;
    }
    if (command.kind === "catalog-validate") {
      const catalog = describeCatalog();
      const message = `Catalog ${catalog.version} is valid: ${catalog.cases.length} cases, ${catalog.scenarios.length} scenarios, ${catalog.suites.length} suites.`;
      writeResult(io, command.options.json, { ok: true, version: catalog.version, message }, message + "\n");
      return 0;
    }
    if (command.kind === "catalog-list") {
      const catalog = await requestJson<CatalogView>(io, command.options.apiUrl, "/api/catalog");
      writeResult(io, command.options.json, filterCatalog(catalog, command.type), formatCatalog(catalog, command.type));
      return 0;
    }
    if (command.kind === "runs-list") {
      const runs = await requestJson<RunView[]>(io, command.options.apiUrl, "/api/runs");
      writeResult(io, command.options.json, runs, formatRuns(runs));
      return 0;
    }
    if (command.kind === "runs-show") {
      const run = await requestJson<RunView>(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(command.id)}`);
      writeResult(io, command.options.json, run, formatRun(run));
      return exitCodeForRun(run.status);
    }
    if (command.kind === "runs-trace") {
      const trace = await fetchCompleteTrace(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(command.id)}/trace${traceQuery(command)}`);
      writeResult(io, command.options.json, trace, formatTrace(trace));
      return 0;
    }
    if (command.kind === "simulators-list") {
      const simulators = await requestJson<SimulatorView[]>(io, command.options.apiUrl, "/api/simulators");
      writeResult(io, command.options.json, simulators, formatSimulators(simulators));
      return 0;
    }
    if (command.kind === "simulators-show") {
      const simulator = await requestJson<SimulatorView>(
        io,
        command.options.apiUrl,
        `/api/simulators/${encodeURIComponent(command.identity)}`,
      );
      writeResult(io, command.options.json, simulator, formatSimulator(simulator));
      return 0;
    }
    if (command.kind === "profiles-show-default") {
      const profile = defaultOcppRunProfile();
      writeResult(io, command.options.json, profile, `${JSON.stringify(profile, null, 2)}\n`);
      return 0;
    }
    if (command.kind === "profiles-validate" || command.kind === "profiles-resolve") {
      const profile = loadProfile(command.path);
      const resolved = resolveOcppRunProfile({ profile });
      if (command.kind === "profiles-validate") {
        const message = `Profile ${resolved.name} is valid.`;
        writeResult(io, command.options.json, { ok: true, name: resolved.name, schemaVersion: resolved.schemaVersion }, message + "\n");
        return 0;
      }
      writeResult(io, command.options.json, resolved, `${JSON.stringify(resolved, null, 2)}\n`);
      return 0;
    }
    if (command.kind === "ci-run" || command.kind === "artifacts-export") {
      return await executeCi(command, io);
    }
    return await executeRun(command, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed";
    const exitCode = error instanceof CliError ? error.exitCode : error instanceof ReportError && ciFamily(argv) ? 4 : ciFamily(argv) ? 6 : 1;
    const details = error instanceof CliError ? error.details : undefined;
    const json = argv.includes("--json");
    io.stderr(json ? `${JSON.stringify({ error: message, ...details })}\n` : `${message}\n`);
    return exitCode;
  }
}

async function executeRun(command: Extract<ParsedCommand, { kind: "run" }>, io: CliIo): Promise<number> {
  let run = await requestJson<RunView>(io, command.options.apiUrl, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preparedRunBody(command, 1)),
  });
  if (!command.options.wait) {
    const profileName = run.profile?.name ? ` using profile ${run.profile.name}` : "";
    writeResult(io, command.options.json, run, `Queued run ${run.id} on ${run.chargePointIdentity}${profileName}.\n`);
    return 0;
  }

  const deadline = io.now() + command.options.timeoutMs;
  while (run.status === "queued" || run.status === "running") {
    if (io.now() > deadline) {
      throw new CliError(`Timed out waiting for run ${run.id}.`, 3);
    }
    await io.sleep(command.options.intervalMs);
    run = await requestJson<RunView>(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(run.id)}`);
  }
  writeResult(io, command.options.json, run, formatRun(run));
  return exitCodeForRun(run.status);
}

async function executeCi(command: Extract<ParsedCommand, { kind: "ci-run" | "artifacts-export" }>, io: CliIo): Promise<number> {
  let runStatus: string | undefined;
  try {
    const runBody = command.kind === "ci-run" ? await queueAndWait(command, io) : await requestJson<unknown>(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(command.id)}`, undefined, 6);
    runStatus = readStatus(runBody);
    if (runStatus === "queued" || runStatus === "running") {
      throw new CliError(`Run ${readId(runBody)} is ${runStatus}. Export a completed run.`, 6, { runStatus });
    }
    const trace = command.artifacts.noTrace
      ? undefined
      : await fetchCompleteTrace(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(readId(runBody))}/trace`, 6);
    const rendered = renderBundle({
      run: runBody,
      ...(trace === undefined ? {} : { trace }),
      generatedAt: new Date(io.now()).toISOString(),
      traceRequested: !command.artifacts.noTrace,
      requireTrace: command.artifacts.requireTrace,
      failOnTruncatedTrace: command.artifacts.failOnTruncatedTrace,
    });
    const directory = await writeArtifacts(command.artifacts.output, rendered.run.id, rendered.files, command.artifacts.overwrite);
    const result = {
      bundleDirectory: directory,
      runId: rendered.run.id,
      runStatus: rendered.run.status,
      artifacts: rendered.files.map((file) => file.name),
      traceSummary: rendered.trace
        ? { ...rendered.trace.summary, exportedEntries: rendered.trace.entries.length }
        : null,
      manifestPath: path.join(directory, "manifest.json"),
      tracePolicy: rendered.policy,
    };
    const warning = rendered.trace?.summary.truncated && rendered.policy.passed ? "Warning: stored trace is truncated.\n" : "";
    const policyLine = rendered.policy.reason ? `Trace policy failed: ${rendered.policy.reason}\n` : "";
    writeResult(
      io,
      command.options.json,
      result,
      `${warning}${policyLine}Exported run ${rendered.run.id} (${rendered.run.status}) to ${directory}\n`,
    );
    return exitCodeForCi({
      runStatus: command.kind === "ci-run" ? rendered.run.status : "passed",
      policyFailed: !rendered.policy.passed,
    });
  } catch (error) {
    if (error instanceof CliError) {
      throw runStatus && error.details?.runStatus === undefined
        ? new CliError(error.message, error.exitCode, { ...error.details, runStatus })
        : error;
    }
    if (error instanceof ReportError) {
      throw new CliError(error.message, 4, runStatus ? { runStatus } : undefined);
    }
    throw error;
  }
}

async function queueAndWait(command: Extract<ParsedCommand, { kind: "ci-run" }>, io: CliIo): Promise<unknown> {
  let run = await requestJson<RunView>(io, command.options.apiUrl, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preparedRunBody(command, 6)),
  }, 6);
  const deadline = io.now() + command.options.timeoutMs;
  while (run.status === "queued" || run.status === "running") {
    if (io.now() > deadline) {
      throw new CliError(`Timed out waiting for run ${run.id}.`, 3, { runStatus: run.status });
    }
    await io.sleep(command.options.intervalMs);
    run = await requestJson<RunView>(io, command.options.apiUrl, `/api/runs/${encodeURIComponent(run.id)}`, undefined, 6);
  }
  return run;
}

function preparedRunBody(
  command: {
    station: string;
    caseIds: string[];
    scenarioIds: string[];
    suiteIds: string[];
    profilePath?: string;
    sets: Array<{ key: string; value: string }>;
    target?: { mode: "embedded" | "external"; urlTemplate?: string };
  },
  exitCode: number,
): Record<string, unknown> {
  const profile = command.profilePath ? loadProfile(command.profilePath, exitCode) : undefined;
  const overrides = Object.fromEntries(command.sets.map((entry) => {
    const parsed = parseProfileOverride(entry.key, entry.value);
    return [parsed.key, parsed.value];
  }));
  resolveOcppRunProfile({
    ...(profile === undefined ? {} : { profile }),
    ...(command.sets.length === 0 ? {} : { overrides }),
  });
  return {
    chargePointIdentity: command.station,
    selection: {
      caseIds: command.caseIds,
      scenarioIds: command.scenarioIds,
      suiteIds: command.suiteIds,
    },
    ...(profile === undefined ? {} : { profile }),
    ...(command.sets.length === 0 ? {} : { overrides }),
    ...(command.target ? { target: command.target } : {}),
  };
}

async function fetchCompleteTrace(io: CliIo, apiUrl: string, requestPath: string, exitCode = 1): Promise<TraceView> {
  const entries: TraceEntryView[] = [];
  let after: number | undefined;
  let latest: TraceView | undefined;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const joiner = requestPath.includes("?") ? "&" : "?";
    const cursor = after === undefined ? "" : `&afterSequence=${after}`;
    const page = await requestJson<TraceView>(io, apiUrl, `${requestPath}${joiner}limit=500${cursor}`, undefined, exitCode);
    latest = page;
    entries.push(...page.entries);
    if (!page.page?.hasMore) {
      return { ...page, entries };
    }
    if (page.page.nextAfterSequence == null || page.page.nextAfterSequence === after) {
      throw new CliError("Trace page did not advance.", exitCode);
    }
    after = page.page.nextAfterSequence;
  }
  if (!latest) {
    throw new CliError("Trace response was empty.", exitCode);
  }
  throw new CliError("Trace pagination did not finish.", exitCode);
}

async function requestJson<T>(io: CliIo, apiUrl: string, requestPath: string, init?: RequestInit, exitCode = 1): Promise<T> {
  let response: Response;
  try {
    response = await io.fetch(`${apiUrl}${requestPath}`, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new CliError(`Cannot reach ${apiUrl}${requestPath}: ${message}`, exitCode);
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new CliError(body.error ?? `${response.status} ${response.statusText}`, exitCode);
  }
  return body as T;
}

function readId(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  throw new CliError("API response did not include a run id.", 6);
}

function readStatus(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "status" in value && typeof value.status === "string") {
    return value.status;
  }
  return undefined;
}

function ciFamily(argv: string[]): boolean {
  const head = argv.find((token) => token !== "--" && !token.startsWith("--"));
  return head === "ci" || head === "artifacts";
}

function loadProfile(filePath: string, exitCode = 1): unknown {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.env.INIT_CWD ?? process.cwd(), filePath);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw new CliError(`Cannot read profile file ${filePath}: ${message}`, exitCode);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`Profile file ${filePath} is not valid JSON.`, exitCode);
  }
}

function writeResult(io: CliIo, json: boolean, value: unknown, text: string): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function filterCatalog(catalog: CatalogView, type: "case" | "scenario" | "suite" | undefined): unknown {
  if (type === "case") {
    return catalog.cases;
  }
  if (type === "scenario") {
    return catalog.scenarios;
  }
  if (type === "suite") {
    return catalog.suites;
  }
  return catalog;
}

function formatCatalog(catalog: CatalogView, type: "case" | "scenario" | "suite" | undefined): string {
  const rows = [
    ...(type === undefined || type === "case" ? catalog.cases.map((item) => line("case", item)) : []),
    ...(type === undefined || type === "scenario" ? catalog.scenarios.map((item) => line("scenario", item)) : []),
    ...(type === undefined || type === "suite" ? catalog.suites.map((item) => line("suite", item)) : []),
  ];
  return rows.length === 0 ? "No catalog entries.\n" : `${rows.join("\n")}\n`;
}

function line(kind: string, item: { id: string; title: string; tags: string[] }): string {
  return `${kind.padEnd(10)} ${item.id.padEnd(24)} ${item.title}  [${item.tags.join(", ")}]`;
}

function formatRuns(runs: RunView[]): string {
  if (runs.length === 0) {
    return "No runs.\n";
  }
  return `${runs.map((run) => `${run.id}  ${run.chargePointIdentity}  ${run.status}`).join("\n")}\n`;
}

function formatRun(run: RunView): string {
  const results = (run.results ?? [])
    .map((result) => `${result.status.padEnd(7)} ${result.title}${result.error ? `  ${result.error}` : ""}`)
    .join("\n");
  return `Run ${run.id} ${run.status} on ${run.chargePointIdentity}\n${results}${results ? "\n" : ""}`;
}

function formatSimulators(simulators: SimulatorView[]): string {
  if (simulators.length === 0) {
    return "No simulators.\n";
  }
  return `${simulators.map((simulator) => formatSimulator(simulator).trimEnd()).join("\n")}\n`;
}

function formatSimulator(simulator: SimulatorView): string {
  const cleanup = simulator.lastCleanup ? (simulator.lastCleanup.ok ? "ok" : "failed") : "unknown";
  return [
    simulator.identity,
    simulator.connected ? "connected" : "disconnected",
    `protocol ${simulator.protocolVersion}`,
    `${simulator.simulatorName} ${simulator.simulatorVersion}`,
    `[${simulator.capabilities.join(", ")}]`,
    `faults ${simulator.activeFaults.length}`,
    `cleanup ${cleanup}`,
  ].join("  ") + "\n";
}

function traceQuery(command: Extract<ParsedCommand, { kind: "runs-trace" }>): string {
  const params = new URLSearchParams();
  if (command.caseId) {
    params.set("caseId", command.caseId);
  }
  if (command.action) {
    params.set("action", command.action);
  }
  if (command.direction) {
    params.set("direction", command.direction);
  }
  if (command.messageType) {
    params.set("messageType", command.messageType);
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function formatTrace(trace: TraceView): string {
  const lines: string[] = [];
  if (trace.profile) {
    lines.push(`Profile ${trace.profile.name} schema ${trace.profile.schemaVersion}`);
  }
  if (trace.summary.truncated) {
    lines.push(
      `Warning: trace is incomplete. Captured ${trace.summary.capturedEntries}, dropped ${trace.summary.droppedEntries}, truncated entries ${trace.summary.truncatedEntries}.`,
    );
  }
  if (trace.entries.length === 0) {
    lines.push("No trace entries.");
  }
  for (const entry of trace.entries) {
    lines.push(formatTraceEntry(entry));
  }
  return `${lines.join("\n")}\n`;
}

function formatTraceEntry(entry: TraceEntryView): string {
  const summary = [
    String(entry.sequence).padStart(4, " "),
    entry.at,
    entry.direction,
    entry.messageType,
    entry.action ?? "-",
    entry.uniqueId ?? "-",
    entry.caseId ?? "-",
  ].join("  ");
  const notes: string[] = [];
  if (entry.originalRawBytes !== undefined) {
    notes.push(`raw truncated from ${entry.originalRawBytes} bytes`);
  }
  if (entry.originalPayloadBytes !== undefined) {
    notes.push(`payload truncated from ${entry.originalPayloadBytes} bytes`);
  }
  const head = notes.length > 0 ? `${summary}  (${notes.join("; ")})` : summary;
  return `${head}\n${formatTraceBody(entry)}`;
}

function formatTraceBody(entry: TraceEntryView): string {
  if (entry.messageType === "CALLERROR") {
    const errorLine = `${entry.errorCode ?? "Error"}${entry.errorDescription ? `: ${entry.errorDescription}` : ""}`;
    const details = entry.payload === undefined ? "" : `\n${JSON.stringify(entry.payload, null, 2)}`;
    return `${errorLine}${details}`;
  }
  if (entry.payload !== undefined) {
    return typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload, null, 2);
  }
  if (entry.raw !== undefined) {
    return entry.raw;
  }
  return "{}";
}

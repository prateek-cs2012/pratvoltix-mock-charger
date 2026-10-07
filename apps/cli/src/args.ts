import { TargetError, resolveCsmsTarget } from "@pratvoltix/simulator-control";

export class CliError extends Error {
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, exitCode = 1, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export interface CliOptions {
  apiUrl: string;
  json: boolean;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
}

export interface RunTargetFlags {
  mode: "embedded" | "external";
  urlTemplate?: string;
}

export type CatalogType = "case" | "scenario" | "suite";

export interface ArtifactFlags {
  output: string;
  overwrite: boolean;
  noTrace: boolean;
  requireTrace: boolean;
  failOnTruncatedTrace: boolean;
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "catalog-list"; type?: CatalogType; options: CliOptions }
  | { kind: "catalog-validate"; options: CliOptions }
  | {
      kind: "run";
      station: string;
      caseIds: string[];
      scenarioIds: string[];
      suiteIds: string[];
      profilePath?: string;
      sets: Array<{ key: string; value: string }>;
      target?: RunTargetFlags;
      options: CliOptions;
    }
  | {
      kind: "ci-run";
      station: string;
      caseIds: string[];
      scenarioIds: string[];
      suiteIds: string[];
      profilePath?: string;
      sets: Array<{ key: string; value: string }>;
      target?: RunTargetFlags;
      artifacts: ArtifactFlags;
      options: CliOptions;
    }
  | { kind: "artifacts-export"; id: string; artifacts: ArtifactFlags; options: CliOptions }
  | { kind: "runs-list"; options: CliOptions }
  | { kind: "runs-show"; id: string; options: CliOptions }
  | { kind: "simulators-list"; options: CliOptions }
  | { kind: "simulators-show"; identity: string; options: CliOptions }
  | { kind: "profiles-show-default"; options: CliOptions }
  | { kind: "profiles-validate"; path: string; options: CliOptions }
  | { kind: "profiles-resolve"; path: string; options: CliOptions }
  | {
      kind: "runs-trace";
      id: string;
      caseId?: string;
      action?: string;
      direction?: string;
      messageType?: string;
      options: CliOptions;
    };

const HELP = `Pratvoltix OCPP lab CLI

Usage:
  pnpm lab -- catalog list [--type case|scenario|suite]
  pnpm lab -- catalog validate
  pnpm lab -- run --station CP001 (--case ID | --scenario ID | --suite ID)... [--profile FILE] [--set key=value]... [--target-mode embedded|external] [--target-url URL] [--wait]
  pnpm lab -- ci run --station CP001 (--case ID | --scenario ID | --suite ID)... [--profile FILE] [--set key=value]... --output DIR
  pnpm lab -- artifacts export <run-id> --output DIR
  pnpm lab -- runs list
  pnpm lab -- runs show <run-id>
  pnpm lab -- runs trace <run-id> [--case ID] [--action ACTION] [--direction DIRECTION] [--message-type TYPE]
  pnpm lab -- simulators list
  pnpm lab -- simulators show <identity>
  pnpm lab -- profiles show-default
  pnpm lab -- profiles validate <path>
  pnpm lab -- profiles resolve <path>

Options:
  --api-url URL       API base URL (default http://localhost:8080)
  --json              Print machine-readable JSON
  --wait              Poll until the run passes, fails, or errors
  --timeout-ms N      Wait deadline in milliseconds (default 120000)
  --interval-ms N     Poll interval in milliseconds (default 1000)
  --profile FILE      Local JSON run profile. Overrides LAB_PROFILE
  --set key=value     Override one profile parameter. Duplicate keys are rejected
  --target-mode MODE  embedded or external. Overrides TARGET_CSMS_URL for this run
  --target-url URL    External OCPP URL. {stationId} is URL-encoded. Secrets belong in
                      TARGET_CSMS_URL, not in this argument: package managers and process
                      listings can echo raw argv.
  --output DIR        Artifact root. The run id is appended as a child directory
  --overwrite         Replace known artifact files in an existing run directory
  --no-trace          Do not fetch or write trace artifacts
  --require-trace     Fail when the stored trace captured no entries
  --fail-on-truncated-trace
                      Fail when the stored trace is truncated
  --action ACTION     Trace filter: OCPP action name
  --direction VALUE   Trace filter: csms-to-charge-point or charge-point-to-csms
  --message-type TYPE Trace filter: CALL, CALLRESULT, CALLERROR, or UNKNOWN
`;

export function helpText(): string {
  return HELP;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  const options: CliOptions = {
    apiUrl: env.LAB_API_URL ?? "http://localhost:8080",
    json: false,
    wait: false,
    timeoutMs: 120_000,
    intervalMs: 1_000,
  };
  const positionals: string[] = [];
  const caseIds: string[] = [];
  const scenarioIds: string[] = [];
  const suiteIds: string[] = [];
  let station: string | undefined;
  let type: CatalogType | undefined;
  let help = false;
  let action: string | undefined;
  let direction: string | undefined;
  let messageType: string | undefined;
  let profilePath: string | undefined;
  let output: string | undefined;
  let overwrite = false;
  let noTrace = false;
  let requireTrace = false;
  let failOnTruncatedTrace = false;
  const sets: Array<{ key: string; value: string }> = [];
  let targetMode: string | undefined;
  let targetUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [flag, inline] = splitFlag(token);
    const read = (name: string): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError(`Missing value for ${name}.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--help":
        help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--wait":
        options.wait = true;
        break;
      case "--api-url":
        options.apiUrl = read("--api-url").replace(/\/$/, "");
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositive("--timeout-ms", read("--timeout-ms"));
        break;
      case "--interval-ms":
        options.intervalMs = readPositive("--interval-ms", read("--interval-ms"));
        break;
      case "--station":
        station = read("--station");
        break;
      case "--case":
        caseIds.push(read("--case"));
        break;
      case "--scenario":
        scenarioIds.push(read("--scenario"));
        break;
      case "--suite":
        suiteIds.push(read("--suite"));
        break;
      case "--profile":
        profilePath = readRequired("--profile", read("--profile"));
        break;
      case "--set": {
        const raw = read("--set");
        const separator = raw.indexOf("=");
        if (separator <= 0) {
          throw new CliError("--set must be key=value.");
        }
        const key = raw.slice(0, separator);
        const value = raw.slice(separator + 1);
        if (sets.some((entry) => entry.key === key)) {
          throw new CliError(`Duplicate override "${key}".`);
        }
        sets.push({ key, value });
        break;
      }
      case "--output":
        output = readRequired("--output", read("--output"));
        break;
      case "--overwrite":
        overwrite = true;
        break;
      case "--no-trace":
        noTrace = true;
        break;
      case "--require-trace":
        requireTrace = true;
        break;
      case "--fail-on-truncated-trace":
        failOnTruncatedTrace = true;
        break;
      case "--type": {
        const value = read("--type");
        if (value !== "case" && value !== "scenario" && value !== "suite") {
          throw new CliError(`--type must be case, scenario, or suite. Received "${value}".`);
        }
        type = value;
        break;
      }
      case "--action":
        action = readRequired("--action", read("--action"));
        break;
      case "--direction":
        direction = read("--direction");
        if (direction !== "csms-to-charge-point" && direction !== "charge-point-to-csms") {
          throw new CliError(
            `--direction must be csms-to-charge-point or charge-point-to-csms. Received "${direction}".`,
          );
        }
        break;
      case "--target-mode":
        targetMode = read("--target-mode");
        if (targetMode !== "embedded" && targetMode !== "external") {
          throw new CliError("--target-mode must be embedded or external.", 6);
        }
        break;
      case "--target-url":
        targetUrl = read("--target-url");
        break;
      case "--message-type":
        messageType = read("--message-type");
        if (
          messageType !== "CALL" &&
          messageType !== "CALLRESULT" &&
          messageType !== "CALLERROR" &&
          messageType !== "UNKNOWN"
        ) {
          throw new CliError(
            `--message-type must be CALL, CALLRESULT, CALLERROR, or UNKNOWN. Received "${messageType}".`,
          );
        }
        break;
      default:
        throw new CliError(`Unknown flag ${flag}.\n\n${HELP}`);
    }
  }

  const tracing = positionals[0] === "runs" && positionals[1] === "trace";
  if (!tracing) {
    rejectTraceFilters(action, direction, messageType);
  }
  const profileCommand = positionals[0] === "profiles";
  const allowsProfile = positionals[0] === "run" || (positionals[0] === "ci" && positionals[1] === "run");
  const allowsArtifacts = (positionals[0] === "ci" && positionals[1] === "run") || (positionals[0] === "artifacts" && positionals[1] === "export");
  const target = readTargetFlags(targetMode, targetUrl, station);
  if (!allowsProfile && (profilePath || sets.length > 0 || target)) {
    throw new CliError("--profile, --set, and target flags are only valid for run and ci run.");
  }
  if (profileCommand && (profilePath || sets.length > 0)) {
    throw new CliError("--profile and --set are only valid for run and ci run.");
  }
  if (!allowsArtifacts && (output || overwrite || noTrace || requireTrace || failOnTruncatedTrace)) {
    throw new CliError("--output, --overwrite, and trace export flags are only valid for ci run and artifacts export.");
  }

  if (help || positionals.length === 0) {
    return { kind: "help" };
  }

  const command = positionals.join(" ");
  if (command === "catalog list") {
    return type ? { kind: "catalog-list", type, options } : { kind: "catalog-list", options };
  }
  if (command === "catalog validate") {
    return { kind: "catalog-validate", options };
  }
  if (command === "run") {
    if (!station) {
      throw new CliError("Missing required flag --station.");
    }
    if (caseIds.length + scenarioIds.length + suiteIds.length === 0) {
      throw new CliError("Provide at least one --case, --scenario, or --suite.");
    }
    return {
      kind: "run",
      station,
      caseIds,
      scenarioIds,
      suiteIds,
      sets,
      ...(profilePath ? { profilePath } : env.LAB_PROFILE ? { profilePath: env.LAB_PROFILE } : {}),
      ...(target ? { target } : {}),
      options,
    };
  }
  if (positionals[0] === "ci" && positionals[1] === "run") {
    if (positionals.length > 2) {
      throw new CliError(`Unexpected argument "${positionals[2]}".`, 6);
    }
    return {
      kind: "ci-run",
      ...requireSelection(station, caseIds, scenarioIds, suiteIds, 6),
      sets,
      ...(profilePath ? { profilePath } : env.LAB_PROFILE ? { profilePath: env.LAB_PROFILE } : {}),
      ...(target ? { target } : {}),
      artifacts: requireArtifacts(output, overwrite, noTrace, requireTrace, failOnTruncatedTrace),
      options,
    };
  }
  if (command === "artifacts export") {
    throw new CliError("artifacts export requires a run id.", 6);
  }
  if (positionals[0] === "artifacts" && positionals[1] === "export") {
    if (!positionals[2]) {
      throw new CliError("artifacts export requires a run id.", 6);
    }
    if (positionals.length > 3) {
      throw new CliError(`Unexpected argument "${positionals[3]}".`, 6);
    }
    if (station || caseIds.length || scenarioIds.length || suiteIds.length || profilePath || sets.length) {
      throw new CliError("artifacts export accepts the run id and artifact options.", 6);
    }
    return {
      kind: "artifacts-export",
      id: positionals[2],
      artifacts: requireArtifacts(output, overwrite, noTrace, requireTrace, failOnTruncatedTrace),
      options,
    };
  }
  if (command === "runs list") {
    rejectTraceFilters(action, direction, messageType);
    return { kind: "runs-list", options };
  }
  if (command === "runs show") {
    throw new CliError("runs show requires a run id.\n\n" + HELP);
  }
  if (command === "runs trace") {
    throw new CliError("runs trace requires a run id.\n\n" + HELP);
  }
  if (positionals[0] === "runs" && positionals[1] === "trace") {
    if (!positionals[2]) {
      throw new CliError("runs trace requires a run id.\n\n" + HELP);
    }
    if (positionals.length > 3) {
      throw new CliError(`Unexpected argument "${positionals[3]}".`);
    }
    if (caseIds.length > 1) {
      throw new CliError("runs trace accepts at most one --case.");
    }
    if (caseIds.some((id) => id.length === 0)) {
      throw new CliError("--case requires a value.");
    }
    if (scenarioIds.length > 0 || suiteIds.length > 0 || station) {
      throw new CliError("runs trace accepts --case, --action, --direction, and --message-type.");
    }
    return {
      kind: "runs-trace",
      id: positionals[2],
      ...(caseIds[0] ? { caseId: caseIds[0] } : {}),
      ...(action ? { action } : {}),
      ...(direction ? { direction } : {}),
      ...(messageType ? { messageType } : {}),
      options,
    };
  }
  if (positionals[0] === "runs" && positionals[1] === "show" && positionals[2]) {
    rejectTraceFilters(action, direction, messageType);
    if (positionals.length > 3) {
      throw new CliError(`Unexpected argument "${positionals[3]}".`);
    }
    return { kind: "runs-show", id: positionals[2], options };
  }
  if (command === "simulators list") {
    rejectTraceFilters(action, direction, messageType);
    return { kind: "simulators-list", options };
  }
  if (command === "simulators show") {
    throw new CliError("simulators show requires an identity.\n\n" + HELP);
  }
  if (positionals[0] === "simulators" && positionals[1] === "show") {
    rejectTraceFilters(action, direction, messageType);
    if (!positionals[2]) {
      throw new CliError("simulators show requires an identity.\n\n" + HELP);
    }
    if (positionals.length > 3) {
      throw new CliError(`Unexpected argument "${positionals[3]}".`);
    }
    return { kind: "simulators-show", identity: positionals[2], options };
  }
  if (command === "profiles show-default") {
    return { kind: "profiles-show-default", options };
  }
  if (command === "profiles validate" || command === "profiles resolve") {
    throw new CliError(`${command} requires a profile path.\n\n` + HELP);
  }
  if (positionals[0] === "profiles" && (positionals[1] === "validate" || positionals[1] === "resolve")) {
    if (!positionals[2]) {
      throw new CliError(`profiles ${positionals[1]} requires a profile path.\n\n` + HELP);
    }
    if (positionals.length > 3) {
      throw new CliError(`Unexpected argument "${positionals[3]}".`);
    }
    return positionals[1] === "validate"
      ? { kind: "profiles-validate", path: positionals[2], options }
      : { kind: "profiles-resolve", path: positionals[2], options };
  }
  if (positionals[0] === "ci" || positionals[0] === "artifacts") {
    throw new CliError(`Unknown command "${command}".\n\n${HELP}`, 6);
  }
  throw new CliError(`Unknown command "${command}".\n\n${HELP}`);
}

export function exitCodeForRun(status: string, timedOut = false): number {
  if (timedOut) {
    return 3;
  }
  if (status === "passed") {
    return 0;
  }
  if (status === "failed") {
    return 1;
  }
  if (status === "error") {
    return 2;
  }
  return 1;
}

export function exitCodeForCi(input: {
  runStatus?: string;
  timedOut?: boolean;
  artifactFailed?: boolean;
  policyFailed?: boolean;
  usageFailed?: boolean;
}): number {
  if (input.usageFailed) {
    return 6;
  }
  if (input.timedOut) {
    return 3;
  }
  if (input.artifactFailed) {
    return 4;
  }
  if (input.policyFailed) {
    return 5;
  }
  if (input.runStatus === "passed") {
    return 0;
  }
  if (input.runStatus === "failed") {
    return 1;
  }
  if (input.runStatus === "error") {
    return 2;
  }
  return 6;
}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf("=");
  if (equals === -1) {
    return [token, undefined];
  }
  return [token.slice(0, equals), token.slice(equals + 1)];
}

function readTargetFlags(mode: string | undefined, url: string | undefined, station: string | undefined): RunTargetFlags | undefined {
  if (mode === undefined && url === undefined) {
    return undefined;
  }
  if ((mode ?? "external") === "embedded") {
    if (url !== undefined) {
      throw new CliError("Embedded mode does not accept --target-url.", 6);
    }
    return { mode: "embedded" };
  }
  if (!url) {
    throw new CliError("External mode requires --target-url.", 6);
  }
  try {
    resolveCsmsTarget({
      stationId: station && /^[A-Za-z0-9_-]{1,48}$/.test(station) ? station : "CP001",
      request: { mode: "external", urlTemplate: url },
      defaultBaseUrl: "ws://localhost:8080/ocpp",
    });
  } catch (error) {
    if (error instanceof TargetError) {
      throw new CliError(error.message, 6);
    }
    throw error;
  }
  return { mode: "external", urlTemplate: url };
}

function rejectTraceFilters(action: string | undefined, direction: string | undefined, messageType: string | undefined): void {
  if (action || direction || messageType) {
    throw new CliError("--action, --direction, and --message-type are only valid for runs trace.");
  }
}

function readRequired(flag: string, value: string): string {
  if (value.length === 0) {
    throw new CliError(`${flag} requires a value.`);
  }
  return value;
}

function readPositive(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function requireSelection(
  station: string | undefined,
  caseIds: string[],
  scenarioIds: string[],
  suiteIds: string[],
  exitCode: number,
): { station: string; caseIds: string[]; scenarioIds: string[]; suiteIds: string[] } {
  if (!station) {
    throw new CliError("Missing required flag --station.", exitCode);
  }
  if (caseIds.length + scenarioIds.length + suiteIds.length === 0) {
    throw new CliError("Provide at least one --case, --scenario, or --suite.", exitCode);
  }
  return { station, caseIds, scenarioIds, suiteIds };
}

function requireArtifacts(
  output: string | undefined,
  overwrite: boolean,
  noTrace: boolean,
  requireTrace: boolean,
  failOnTruncatedTrace: boolean,
): ArtifactFlags {
  if (!output) {
    throw new CliError("Missing required flag --output.", 6);
  }
  if (noTrace && (requireTrace || failOnTruncatedTrace)) {
    throw new CliError("--no-trace cannot be combined with --require-trace or --fail-on-truncated-trace.", 6);
  }
  return { output, overwrite, noTrace, requireTrace, failOnTruncatedTrace };
}

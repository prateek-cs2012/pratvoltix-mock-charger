import { publicTargetSnapshot, resolveCsmsTarget, TargetError, type ResolvedCsmsTarget } from "@pratvoltix/simulator-control";
import { CatalogError, ProfileError, resolveOcppRunProfile, resolveSelection, type EffectiveOcppRunProfile, type ExecutionPlan } from "@pratvoltix/test-cases";
import { HttpError } from "./http-error.js";

export interface PreparedRun {
  chargePointIdentity: string;
  caseIds: string[];
  selection: ExecutionPlan["selection"];
  plan: ExecutionPlan;
  profile: EffectiveOcppRunProfile;
  target: ResolvedCsmsTarget;
}

export interface PrepareRunOptions {
  environmentUrl?: string;
  defaultBaseUrl?: string;
}

export function prepareRun(body: unknown, options: PrepareRunOptions = {}): PreparedRun {
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.chargePointIdentity !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(record.chargePointIdentity)) {
    throw new HttpError(400, "chargePointIdentity must be 1-48 letters, numbers, hyphens, or underscores");
  }

  const hasSelection = record.selection !== undefined;
  const hasCaseIds = record.caseIds !== undefined;
  if (hasSelection && hasCaseIds) {
    throw new HttpError(400, "Provide either selection or caseIds, not both.");
  }
  if (!hasSelection && !hasCaseIds) {
    throw new HttpError(400, "Provide selection or caseIds.");
  }

  try {
    const plan = hasSelection
      ? resolveSelection(parseSelection(record.selection))
      : resolveSelection({ caseIds: parseStringList(record.caseIds, "caseIds") });
    const profile = resolveOcppRunProfile({
      ...(record.profile === undefined ? {} : { profile: record.profile }),
      ...(record.overrides === undefined ? {} : { overrides: record.overrides }),
    });
    const target = resolveCsmsTarget({
      stationId: record.chargePointIdentity,
      ...(record.target === undefined ? {} : { request: parseTarget(record.target) }),
      ...(options.environmentUrl === undefined ? {} : { environmentUrl: options.environmentUrl }),
      defaultBaseUrl: options.defaultBaseUrl ?? "ws://localhost:8080/ocpp",
    });
    if (target.mode === "external") {
      rejectIncompatibleCases(plan);
    }
    return {
      chargePointIdentity: record.chargePointIdentity,
      caseIds: plan.cases.map((testCase) => testCase.id),
      selection: plan.selection,
      plan,
      profile,
      target,
    };
  } catch (error) {
    if (error instanceof CatalogError || error instanceof ProfileError || error instanceof TargetError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

export function storedTarget(target: ResolvedCsmsTarget) {
  return publicTargetSnapshot(target);
}

function parseTarget(value: unknown): { mode: "embedded" | "external"; urlTemplate?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "target must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.mode !== "embedded" && record.mode !== "external") {
    throw new HttpError(400, "target.mode must be embedded or external");
  }
  if (record.urlTemplate !== undefined && typeof record.urlTemplate !== "string") {
    throw new HttpError(400, "target.urlTemplate must be a string");
  }
  return {
    mode: record.mode,
    ...(typeof record.urlTemplate === "string" ? { urlTemplate: record.urlTemplate } : {}),
  };
}

function rejectIncompatibleCases(plan: ExecutionPlan): void {
  const blocked = plan.cases.filter((testCase) => testCase.deployment !== "external-compatible");
  if (blocked.length === 0) {
    return;
  }
  const groups = new Map<string, string[]>();
  for (const testCase of blocked) {
    const ids = groups.get(testCase.deployment) ?? [];
    ids.push(testCase.id);
    groups.set(testCase.deployment, ids);
  }
  const detail = [...groups.entries()].map(([deployment, ids]) => `${deployment} cases: ${ids.join(", ")}`).join("; ");
  throw new HttpError(400, `External mode cannot run ${detail}. Those cases were not executed.`);
}

function parseSelection(value: unknown): { caseIds: string[]; scenarioIds: string[]; suiteIds: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "selection must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    caseIds: record.caseIds === undefined ? [] : parseStringList(record.caseIds, "selection.caseIds"),
    scenarioIds: record.scenarioIds === undefined ? [] : parseStringList(record.scenarioIds, "selection.scenarioIds"),
    suiteIds: record.suiteIds === undefined ? [] : parseStringList(record.suiteIds, "selection.suiteIds"),
  };
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new HttpError(400, `${field} must be an array of non-empty strings`);
  }
  return value;
}

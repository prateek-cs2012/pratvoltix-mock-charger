import { ControlProtocolError } from "./errors.js";

export const MAX_ACTIVE_FAULTS = 16;
export const MAX_DELAY_MS = 30_000;
const MAX_PAYLOAD_JSON = 8_192;
const MAX_DEPTH = 8;

export type FaultEffect =
  | { type: "delay"; delayMs: number }
  | { type: "call-result"; payload: Record<string, unknown> }
  | { type: "call-error"; errorCode: string; description: string; details?: Record<string, unknown> }
  | { type: "suppress-response" }
  | { type: "disconnect" }
  | { type: "malformed-response"; rawPayload: string };

export interface FaultRule {
  id: string;
  match: {
    action: string;
    occurrence: number;
  };
  effect: FaultEffect;
  consume: "once";
}

export interface FaultSummary {
  id: string;
  action: string;
  occurrence: number;
  effectType: FaultEffect["type"];
}

export interface ReconnectStormConfig {
  burstCount: number;
  burstDelayMs: number;
  intervalMs: number;
}

export function validateReconnectStormConfig(input: unknown): ReconnectStormConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ControlProtocolError("invalid-config", "Reconnect storm config must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.burstCount !== "number" || !Number.isInteger(record.burstCount) || record.burstCount < 1 || record.burstCount > 100) {
    throw new ControlProtocolError("invalid-config", "burstCount must be an integer from 1 to 100.");
  }
  if (typeof record.burstDelayMs !== "number" || !Number.isInteger(record.burstDelayMs) || record.burstDelayMs < 0 || record.burstDelayMs > MAX_DELAY_MS) {
    throw new ControlProtocolError("invalid-config", `burstDelayMs must be an integer from 0 to ${MAX_DELAY_MS}.`);
  }
  if (typeof record.intervalMs !== "number" || !Number.isInteger(record.intervalMs) || record.intervalMs < 0 || record.intervalMs > MAX_DELAY_MS) {
    throw new ControlProtocolError("invalid-config", `intervalMs must be an integer from 0 to ${MAX_DELAY_MS}.`);
  }
  return {
    burstCount: record.burstCount,
    burstDelayMs: record.burstDelayMs,
    intervalMs: record.intervalMs,
  };
}

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function validateFaultRule(input: unknown): FaultRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ControlProtocolError("invalid-rule", "Fault rule must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.id !== "string" || !RULE_ID.test(record.id)) {
    throw new ControlProtocolError("invalid-rule", "Fault rule id must be 1-64 letters, numbers, hyphens, or underscores.");
  }
  if (record.consume !== "once") {
    throw new ControlProtocolError("invalid-rule", `Fault rule "${record.id}" must set consume to "once".`);
  }
  const match = record.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    throw new ControlProtocolError("invalid-rule", `Fault rule "${record.id}" is missing match.`);
  }
  const matchRecord = match as Record<string, unknown>;
  if (typeof matchRecord.action !== "string" || !ACTION_NAME.test(matchRecord.action)) {
    throw new ControlProtocolError("invalid-rule", `Fault rule "${record.id}" match.action must be an OCPP action name.`);
  }
  const occurrence = matchRecord.occurrence === undefined ? 1 : matchRecord.occurrence;
  if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > 100) {
    throw new ControlProtocolError("invalid-rule", `Fault rule "${record.id}" occurrence must be an integer from 1 to 100.`);
  }
  return {
    id: record.id,
    match: { action: matchRecord.action, occurrence },
    effect: validateEffect(record.id, record.effect),
    consume: "once",
  };
}

export function summarizeFault(rule: FaultRule): FaultSummary {
  return {
    id: rule.id,
    action: rule.match.action,
    occurrence: rule.match.occurrence,
    effectType: rule.effect.type,
  };
}

export function readFaultSummaries(payload: unknown): FaultSummary[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ControlProtocolError("invalid-message", "Fault list payload must be an object.");
  }
  const faults = (payload as { faults?: unknown }).faults;
  if (!Array.isArray(faults)) {
    throw new ControlProtocolError("invalid-message", "Fault list payload is missing faults.");
  }
  return faults.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ControlProtocolError("invalid-message", "Fault summary must be an object.");
    }
    const summary = entry as Record<string, unknown>;
    if (typeof summary.id !== "string" || typeof summary.action !== "string" || typeof summary.effectType !== "string") {
      throw new ControlProtocolError("invalid-message", "Fault summary is missing id, action, or effectType.");
    }
    if (typeof summary.occurrence !== "number" || !Number.isInteger(summary.occurrence)) {
      throw new ControlProtocolError("invalid-message", "Fault summary occurrence must be an integer.");
    }
    if (!isEffectType(summary.effectType)) {
      throw new ControlProtocolError("invalid-message", `Unknown fault effect "${summary.effectType}".`);
    }
    return {
      id: summary.id,
      action: summary.action,
      occurrence: summary.occurrence,
      effectType: summary.effectType,
    };
  });
}

export function readClearFaultResult(payload: unknown): { cleared: boolean; alreadyConsumed: boolean } {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "Clear-fault payload must be an object.");
  }
  const record = payload as { cleared?: unknown; alreadyConsumed?: unknown };
  if (typeof record.cleared !== "boolean" || typeof record.alreadyConsumed !== "boolean") {
    throw new ControlProtocolError("invalid-message", "Clear-fault payload must include cleared and alreadyConsumed booleans.");
  }
  return { cleared: record.cleared, alreadyConsumed: record.alreadyConsumed };
}

function validateEffect(id: string, effect: unknown): FaultEffect {
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) {
    throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" is missing effect.`);
  }
  const record = effect as Record<string, unknown>;
  if (record.type === "delay") {
    if (typeof record.delayMs !== "number" || !Number.isInteger(record.delayMs) || record.delayMs < 0 || record.delayMs > MAX_DELAY_MS) {
      throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" delayMs must be an integer from 0 to ${MAX_DELAY_MS}.`);
    }
    return { type: "delay", delayMs: record.delayMs };
  }
  if (record.type === "call-result") {
    assertJsonObject(record.payload, `Fault rule "${id}" CALLRESULT payload`);
    assertJsonSize(record.payload, `Fault rule "${id}" CALLRESULT payload`);
    return { type: "call-result", payload: cloneJson(record.payload) };
  }
  if (record.type === "call-error") {
    if (typeof record.errorCode !== "string" || record.errorCode.length === 0 || record.errorCode.length > 64) {
      throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" errorCode must be a non-empty string.`);
    }
    if (typeof record.description !== "string" || record.description.length > 512) {
      throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" description must be a string.`);
    }
    if (record.details !== undefined) {
      assertJsonObject(record.details, `Fault rule "${id}" CALLERROR details`);
      assertJsonSize(record.details, `Fault rule "${id}" CALLERROR details`);
    }
    return {
      type: "call-error",
      errorCode: record.errorCode,
      description: record.description,
      ...(record.details === undefined ? {} : { details: cloneJson(record.details as Record<string, unknown>) }),
    };
  }
  if (record.type === "suppress-response") {
    return { type: "suppress-response" };
  }
  if (record.type === "disconnect") {
    return { type: "disconnect" };
  }
  if (record.type === "malformed-response") {
    if (typeof record.rawPayload !== "string" || record.rawPayload.length === 0 || record.rawPayload.length > MAX_PAYLOAD_JSON) {
      throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" rawPayload must be a non-empty string up to ${MAX_PAYLOAD_JSON} characters.`);
    }
    return { type: "malformed-response", rawPayload: record.rawPayload };
  }
  throw new ControlProtocolError("invalid-rule", `Fault rule "${id}" has an unsupported effect.`);
}

function isEffectType(value: string): value is FaultEffect["type"] {
  return (
    value === "delay" ||
    value === "call-result" ||
    value === "call-error" ||
    value === "suppress-response" ||
    value === "disconnect" ||
    value === "malformed-response"
  );
}

function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isJsonObject(value, 0)) {
    throw new ControlProtocolError("invalid-rule", `${label} must be a JSON object.`);
  }
}

function assertJsonSize(value: unknown, label: string): void {
  if (JSON.stringify(value).length > MAX_PAYLOAD_JSON) {
    throw new ControlProtocolError("invalid-rule", `${label} exceeds ${MAX_PAYLOAD_JSON} characters.`);
  }
}

function isJsonObject(value: unknown, depth: number): value is Record<string, unknown> {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((inner) => isJsonValue(inner, depth + 1));
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value !== "string" || value.length <= MAX_PAYLOAD_JSON;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return depth <= MAX_DEPTH && value.every((inner) => isJsonValue(inner, depth + 1));
  }
  return isJsonObject(value, depth);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

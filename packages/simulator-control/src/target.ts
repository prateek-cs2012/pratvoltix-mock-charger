const REDACTED = "redacted";
const STATION_TOKEN = "___STATION___";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "");
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export interface CsmsTargetRequest {
  mode: "embedded" | "external";
  urlTemplate?: string;
}

export interface CsmsTargetSnapshot {
  mode: "embedded" | "external";
  configurationSource: "run" | "environment" | "default";
  urlTemplate: string;
  resolvedEndpoint: string;
  stationIdentity: string;
  requestedSubprotocol: "ocpp1.6";
  negotiatedSubprotocol: string | null;
}

export interface ResolvedCsmsTarget extends CsmsTargetSnapshot {
  /** Transient connection URL. Do not persist, log, or return this value. */
  rawEndpoint: string;
}

export function publicTargetSnapshot(target: ResolvedCsmsTarget, negotiatedSubprotocol: string | null = null): CsmsTargetSnapshot {
  return {
    mode: target.mode,
    configurationSource: target.configurationSource,
    urlTemplate: target.urlTemplate,
    resolvedEndpoint: target.resolvedEndpoint,
    stationIdentity: target.stationIdentity,
    requestedSubprotocol: target.requestedSubprotocol,
    negotiatedSubprotocol,
  };
}

export function sanitizeCsmsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid-url";
  }
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, REDACTED);
  }
  return parsed.toString();
}

export function sanitizeCsmsTemplate(template: string): string {
  const substituted = template.replaceAll("{stationId}", STATION_TOKEN);
  if (placeholders(substituted).length > 0 || substituted.includes("{") || substituted.includes("}")) {
    return "invalid-url";
  }
  return sanitizeCsmsUrl(substituted).replaceAll(STATION_TOKEN, "{stationId}");
}

export function resolveCsmsTarget(input: {
  stationId: string;
  request?: CsmsTargetRequest;
  environmentUrl?: string;
  defaultBaseUrl: string;
}): ResolvedCsmsTarget {
  const environmentUrl = input.environmentUrl?.trim() ?? "";
  if (input.request) {
    if (input.request.mode === "embedded") {
      if (input.request.urlTemplate !== undefined && input.request.urlTemplate.trim() !== "") {
        throw new TargetError("Embedded mode does not accept a target URL.");
      }
      return embeddedTarget(input.stationId, input.defaultBaseUrl, "run");
    }
    if (input.request.mode !== "external") {
      throw new TargetError("Target mode must be embedded or external.");
    }
    const template = input.request.urlTemplate?.trim() ?? "";
    if (!template) {
      throw new TargetError("External mode requires a target URL.");
    }
    return externalTarget(input.stationId, template, "run");
  }
  if (environmentUrl) {
    return externalTarget(input.stationId, environmentUrl, "environment");
  }
  return embeddedTarget(input.stationId, input.defaultBaseUrl, "default");
}

export function safeConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || message.includes("://") || message.includes("@") || message.includes("?")) {
    return "External CSMS connection failed.";
  }
  return message;
}

function embeddedTarget(
  stationId: string,
  defaultBaseUrl: string,
  configurationSource: CsmsTargetSnapshot["configurationSource"],
): ResolvedCsmsTarget {
  const template = `${defaultBaseUrl.replace(/\/$/, "")}/{stationId}`;
  const resolved = applyTemplate(template, stationId);
  return snapshot(stationId, "embedded", configurationSource, template, resolved.rawEndpoint);
}

function externalTarget(
  stationId: string,
  template: string,
  configurationSource: CsmsTargetSnapshot["configurationSource"],
): ResolvedCsmsTarget {
  const resolved = applyTemplate(template, stationId);
  return snapshot(stationId, "external", configurationSource, template, resolved.rawEndpoint);
}

function snapshot(
  stationId: string,
  mode: CsmsTargetSnapshot["mode"],
  configurationSource: CsmsTargetSnapshot["configurationSource"],
  template: string,
  rawEndpoint: string,
): ResolvedCsmsTarget {
  return {
    mode,
    configurationSource,
    urlTemplate: sanitizeCsmsTemplate(template),
    resolvedEndpoint: sanitizeCsmsUrl(rawEndpoint),
    stationIdentity: stationId,
    requestedSubprotocol: "ocpp1.6",
    negotiatedSubprotocol: null,
    rawEndpoint,
  };
}

function applyTemplate(template: string, stationId: string): { rawEndpoint: string } {
  const names = placeholders(template);
  for (const name of names) {
    if (name !== "stationId") {
      throw new TargetError(`Unknown target placeholder "{${name}}".`);
    }
  }
  if ((template.includes("{") || template.includes("}")) && names.length === 0) {
    throw new TargetError("Target URL template was not fully resolved.");
  }
  let raw = template;
  if (names.length > 0) {
    raw = template.replaceAll("{stationId}", encodeURIComponent(stationId));
    if (raw.includes("{") || raw.includes("}")) {
      throw new TargetError("Target URL template was not fully resolved.");
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TargetError("Target URL is malformed.");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TargetError("Target URL must use ws: or wss:.");
  }
  if (names.length === 0) {
    const path = parsed.pathname.replace(/\/$/, "");
    parsed.pathname = `${path}/${encodeURIComponent(stationId)}`;
  }
  return { rawEndpoint: parsed.toString() };
}

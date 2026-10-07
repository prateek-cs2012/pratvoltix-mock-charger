import { randomUUID } from "node:crypto";
import { ControlProtocolError } from "./errors.js";

export const CONTROL_PROTOCOL_VERSION = "1";
export const CONTROL_SUBPROTOCOL = "pratvoltix-lab-control.v1";
export const SIMULATOR_CAPABILITY = "simulator-control";
export const CONTROL_PATH = "/lab-control";

export const CONTROL_ACTIONS = [
  "hello",
  "arm-fault",
  "clear-fault",
  "clear-all-faults",
  "list-faults",
  "get-status",
  "connect-ocpp",
  "disconnect-ocpp",
  "emit-ocpp",
  "ocpp-frame",
  "ocpp-state",
  "set-reconnect-storm",
  "clear-reconnect-storm",
  "set-outbound-delay",
  "clear-outbound-delay",
  "set-local-auth-list",
  "get-local-auth-list",
  "upload-offline-transactions",
  "queue-offline-transaction",
  "retry-start-transaction",
  "retry-stop-transaction",
  "restore-transaction-state",
  "reset-connector-idle",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ControlRequest {
  type: "request";
  requestId: string;
  action: ControlAction;
  payload: unknown;
}

export interface ControlErrorBody {
  code: string;
  message: string;
}

export interface ControlResponse {
  type: "response";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: ControlErrorBody;
}

export interface HelloPayload {
  protocolVersion: string;
  chargePointIdentity: string;
  simulatorName: string;
  simulatorVersion: string;
  capabilities: string[];
}

export interface ControlChannelOptions {
  timeoutMs?: number;
  maxPending?: number;
  onRequest?(request: ControlRequest): Promise<unknown> | unknown;
  onProtocolError?(error: Error): void;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING = 32;
const MAX_MESSAGE_CHARS = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const IDENTITY = /^[A-Za-z0-9_-]{1,48}$/;

export class ControlChannel {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inbound = new Set<string>();
  private closed = false;

  constructor(
    private readonly sendRaw: (text: string) => void,
    private readonly options: ControlChannelOptions = {},
  ) {}

  request(action: ControlAction, payload: unknown = {}, timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ControlProtocolError("disconnected", "Control connection is closed."));
    }
    if (this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      return Promise.reject(new ControlProtocolError("too-many-requests", "Too many pending control requests."));
    }
    const requestId = randomUUID();
    const message: ControlRequest = { type: "request", requestId, action, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ControlProtocolError("timeout", `Control request ${action} timed out.`, requestId));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
      });
      try {
        this.dispatch(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new ControlProtocolError("send-failed", "Failed to send the control request."));
      }
    });
  }

  handleRaw(raw: string): void {
    if (this.closed) {
      return;
    }
    if (raw.length > MAX_MESSAGE_CHARS) {
      this.failProtocol(new ControlProtocolError("invalid-message", "Control message exceeds the size limit."));
      return;
    }
    let message: ControlRequest | ControlResponse;
    try {
      message = parseControlMessage(raw);
    } catch (error) {
      const protocolError = error instanceof ControlProtocolError
        ? error
        : new ControlProtocolError("invalid-message", "Invalid control message.");
      if (protocolError.requestId) {
        this.sendResponse({
          type: "response",
          requestId: protocolError.requestId,
          ok: false,
          error: { code: protocolError.code, message: protocolError.message },
        });
      }
      this.failProtocol(protocolError);
      return;
    }
    if (message.type === "response") {
      this.takeResponse(message);
      return;
    }
    void this.dispatchRequest(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ControlProtocolError("disconnected", "Control connection closed."));
    }
    this.pending.clear();
    this.inbound.clear();
  }

  private async dispatchRequest(request: ControlRequest): Promise<void> {
    if (this.pending.has(request.requestId) || this.inbound.has(request.requestId)) {
      this.sendResponse({
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: { code: "duplicate-request", message: `Request ${request.requestId} is already pending.` },
      });
      return;
    }
    this.inbound.add(request.requestId);
    try {
      if (!this.options.onRequest) {
        throw new ControlProtocolError("not-supported", "This peer does not accept control requests.");
      }
      const payload = await this.options.onRequest(request);
      if (this.closed) {
        return;
      }
      this.sendResponse({
        type: "response",
        requestId: request.requestId,
        ok: true,
        ...(payload === undefined ? {} : { payload }),
      });
    } catch (error) {
      if (this.closed) {
        return;
      }
      const protocolError = error instanceof ControlProtocolError
        ? error
        : new ControlProtocolError("handler-failed", error instanceof Error ? error.message : "Control request failed.");
      this.sendResponse({
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: { code: protocolError.code, message: protocolError.message },
      });
    } finally {
      this.inbound.delete(request.requestId);
    }
  }

  private takeResponse(response: ControlResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      this.failProtocol(new ControlProtocolError("unknown-response", `No pending request matches ${response.requestId}.`, response.requestId));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (!response.ok) {
      pending.reject(new ControlProtocolError(response.error?.code ?? "request-failed", response.error?.message ?? "Control request failed.", response.requestId));
      return;
    }
    pending.resolve(response.payload);
  }

  private sendResponse(response: ControlResponse): void {
    try {
      this.dispatch(JSON.stringify(response));
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new ControlProtocolError("send-failed", "Failed to send the control response."));
    }
  }

  private dispatch(text: string): void {
    try {
      this.sendRaw(text);
    } catch (error) {
      throw error instanceof Error ? error : new ControlProtocolError("send-failed", "Failed to send.");
    }
  }

  private failProtocol(error: Error): void {
    try {
      this.options.onProtocolError?.(error);
    } catch {
      // Control diagnostics must not break the socket.
    }
  }
}

export function parseControlMessage(raw: string): ControlRequest | ControlResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlProtocolError("invalid-message", "Control message is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ControlProtocolError("invalid-message", "Control message must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const requestId = readRequestId(record.requestId);
  if (record.type === "request") {
    if (typeof record.action !== "string" || !isControlAction(record.action)) {
      throw new ControlProtocolError("invalid-message", `Unsupported control action "${String(record.action)}".`, requestId);
    }
    return {
      type: "request",
      requestId,
      action: record.action,
      payload: record.payload === undefined ? {} : record.payload,
    };
  }
  if (record.type === "response") {
    if (typeof record.ok !== "boolean") {
      throw new ControlProtocolError("invalid-message", "Control response ok must be a boolean.", requestId);
    }
    const response: ControlResponse = { type: "response", requestId, ok: record.ok };
    if (record.payload !== undefined) {
      response.payload = record.payload;
    }
    if (record.error !== undefined) {
      response.error = readError(record.error, requestId);
    }
    if (!record.ok && !response.error) {
      throw new ControlProtocolError("invalid-message", "A failed control response must include an error.", requestId);
    }
    return response;
  }
  throw new ControlProtocolError("invalid-message", "Control message type must be request or response.", requestId);
}

export function validateHello(payload: unknown): HelloPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ControlProtocolError("invalid-message", "Hello payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.protocolVersion !== "string" || record.protocolVersion.length === 0) {
    throw new ControlProtocolError("invalid-message", "Hello payload is missing protocolVersion.");
  }
  if (record.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw new ControlProtocolError("unsupported-version", `Unsupported control protocol version "${record.protocolVersion}".`);
  }
  if (typeof record.chargePointIdentity !== "string" || !IDENTITY.test(record.chargePointIdentity)) {
    throw new ControlProtocolError("invalid-message", "Hello chargePointIdentity must be 1-48 letters, numbers, hyphens, or underscores.");
  }
  if (typeof record.simulatorName !== "string" || record.simulatorName.trim().length === 0 || record.simulatorName.length > 80) {
    throw new ControlProtocolError("invalid-message", "Hello simulatorName must be a non-empty string.");
  }
  if (typeof record.simulatorVersion !== "string" || record.simulatorVersion.trim().length === 0 || record.simulatorVersion.length > 40) {
    throw new ControlProtocolError("invalid-message", "Hello simulatorVersion must be a non-empty string.");
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 64)) {
    throw new ControlProtocolError("invalid-message", "Hello capabilities must be an array of strings.");
  }
  if (!record.capabilities.includes(SIMULATOR_CAPABILITY)) {
    throw new ControlProtocolError("invalid-message", `Hello capabilities must include ${SIMULATOR_CAPABILITY}.`);
  }
  return {
    protocolVersion: record.protocolVersion,
    chargePointIdentity: record.chargePointIdentity,
    simulatorName: record.simulatorName.trim(),
    simulatorVersion: record.simulatorVersion.trim(),
    capabilities: [...new Set(record.capabilities)],
  };
}

function readRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new ControlProtocolError("invalid-message", "Control requestId must be 1-80 letters, numbers, hyphens, or underscores.");
  }
  return value;
}

function readError(value: unknown, requestId: string): ControlErrorBody {
  if (typeof value !== "object" || value === null) {
    throw new ControlProtocolError("invalid-message", "Control error must be an object.", requestId);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.length === 0 || typeof record.message !== "string") {
    throw new ControlProtocolError("invalid-message", "Control error must include code and message.", requestId);
  }
  return { code: record.code, message: record.message };
}

function isControlAction(value: string): value is ControlAction {
  return (CONTROL_ACTIONS as readonly string[]).includes(value);
}

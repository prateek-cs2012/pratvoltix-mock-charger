import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SUBPROTOCOL,
  ControlChannel,
  ControlProtocolError,
  MAX_DELAY_MS,
  SIMULATOR_CAPABILITY,
  validateFaultRule,
  validateReconnectStormConfig,
  type ControlRequest,
  type ReconnectStormConfig,
} from "@pratvoltix/simulator-control";
import WebSocket from "ws";
import type { FaultEngine } from "./fault-engine.js";
import type { LocalAuthEntry, OfflineTransaction } from "./mock-charge-point.js";

const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

export function nextControlBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
}

export interface ControlSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface SimulatorControlClientOptions {
  url: string;
  identity: string;
  simulatorName: string;
  simulatorVersion: string;
  faults: FaultEngine;
  disconnectOcpp: () => void;
  connectOcpp?: (url: string) => Promise<{ state: "connected"; subprotocol: string }>;
  disconnectTarget?: (restoreBootstrap: boolean) => Promise<{ state: "disconnected" }>;
  emitOcpp?: (action: string, connectorId?: number) => Promise<{ status: "Accepted" }>;
  setReconnectStorm?: (config: ReconnectStormConfig | undefined) => void;
  getReconnectStorm?: () => ReconnectStormConfig | undefined;
  resetToIdle?: () => Promise<void>;
  localStart?: (idTag: string, connectorId?: number) => Promise<void>;
  localStop?: (reason?: string) => Promise<void>;
  setConnectorStatus?: (status: string, errorCode?: string) => Promise<void>;
  setOutboundDelay?: (delayMs: number) => void;
  getOutboundDelay?: () => number;
  setLocalAuthList?: (entries: LocalAuthEntry[]) => void;
  getLocalAuthList?: () => LocalAuthEntry[];
  uploadOfflineTransactions?: () => Promise<number>;
  queueOfflineTransaction?: (tx: OfflineTransaction) => void;
  retryStartTransaction?: (idTag: string, connectorId?: number) => Promise<void>;
  retryStopTransaction?: () => Promise<void>;
  restoreTransactionState?: (state: {
    transactionId: number;
    idTag: string;
    connectorStatus?: string;
  }) => void;
  openSocket?: (url: string) => ControlSocket;
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
}

export class SimulatorControlClient {
  private stopped = false;
  private attempt = 0;
  private timer: { cancel(): void } | undefined;
  private channel: ControlChannel | undefined;

  constructor(private readonly options: SimulatorControlClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.channel?.close();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const socket = (this.options.openSocket ?? openWebSocket)(this.options.url);
    socket.on("open", () => {
      this.attempt = 0;
      this.options.faults.clearAll();
      this.channel = new ControlChannel((text) => socket.send(text), {
        onProtocolError: (error) => console.error(`[lab-control] ${error.message}`),
        onRequest: (request) => this.handleRequest(request),
      });
      void this.channel
        .request("hello", {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          chargePointIdentity: this.options.identity,
          simulatorName: this.options.simulatorName,
          simulatorVersion: this.options.simulatorVersion,
          capabilities: [SIMULATOR_CAPABILITY],
        })
        .then(() => console.log(`[lab-control] ${this.options.identity} ready`))
        .catch((error: unknown) => {
          console.error("[lab-control] hello failed", error);
          socket.close();
        });
    });
    socket.on("message", (data) => {
      try {
        this.channel?.handleRaw(String(data));
      } catch (error) {
        console.error("[lab-control] message failed", error);
      }
    });
    socket.on("close", () => {
      this.channel?.close();
      this.channel = undefined;
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      console.error(`[lab-control] ${error.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) {
      return;
    }
    const delayMs = nextControlBackoff(this.attempt);
    this.attempt += 1;
    const schedule = this.options.schedule ?? defaultSchedule;
    this.timer = schedule(() => {
      this.timer = undefined;
      this.connect();
    }, delayMs);
  }

  private async handleRequest(request: ControlRequest): Promise<unknown> {
    try {
      return this.dispatch(request);
    } catch (error) {
      if (error instanceof ControlProtocolError) {
        throw error;
      }
      console.error("[lab-control] fault handler failed", error);
      throw new ControlProtocolError("handler-failed", "The fault engine failed closed.");
    }
  }

  private dispatch(request: ControlRequest): unknown {
    if (request.action === "arm-fault") {
      this.options.faults.arm(validateFaultRule(request.payload));
      return { armed: true };
    }
    if (request.action === "clear-fault") {
      const id = readFaultId(request.payload);
      return this.options.faults.clear(id);
    }
    if (request.action === "clear-all-faults") {
      return { cleared: this.options.faults.clearAll() };
    }
    if (request.action === "list-faults") {
      return { faults: this.options.faults.list() };
    }
    if (request.action === "connect-ocpp") {
      return this.connectTarget(request.payload);
    }
    if (request.action === "disconnect-ocpp") {
      return this.disconnectTarget(request.payload);
    }
    if (request.action === "emit-ocpp") {
      return this.emitTarget(request.payload);
    }
    if (request.action === "get-status") {
      return {
        chargePointIdentity: this.options.identity,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        simulatorName: this.options.simulatorName,
        simulatorVersion: this.options.simulatorVersion,
        capabilities: [SIMULATOR_CAPABILITY],
        activeFaults: this.options.faults.list(),
        reconnectStorm: this.options.getReconnectStorm?.(),
      };
    }
    if (request.action === "set-reconnect-storm") {
      if (!this.options.setReconnectStorm) {
        throw new ControlProtocolError("not-ready", "Reconnect storm is not supported.");
      }
      const config = validateReconnectStormConfig(request.payload);
      this.options.setReconnectStorm(config);
      return { configured: true, ...config };
    }
    if (request.action === "clear-reconnect-storm") {
      if (!this.options.setReconnectStorm) {
        throw new ControlProtocolError("not-ready", "Reconnect storm is not supported.");
      }
      this.options.setReconnectStorm(undefined);
      return { cleared: true };
    }
    if (request.action === "set-outbound-delay") {
      if (!this.options.setOutboundDelay) {
        throw new ControlProtocolError("not-ready", "Outbound delay is not supported.");
      }
      const delayMs = readDelayMs(request.payload);
      this.options.setOutboundDelay(delayMs);
      return { configured: true, delayMs };
    }
    if (request.action === "clear-outbound-delay") {
      if (!this.options.setOutboundDelay) {
        throw new ControlProtocolError("not-ready", "Outbound delay is not supported.");
      }
      this.options.setOutboundDelay(0);
      return { cleared: true };
    }
    if (request.action === "set-local-auth-list") {
      if (!this.options.setLocalAuthList) {
        throw new ControlProtocolError("not-ready", "Local auth list is not supported.");
      }
      const entries = readLocalAuthList(request.payload);
      this.options.setLocalAuthList(entries);
      return { configured: true, count: entries.length };
    }
    if (request.action === "get-local-auth-list") {
      if (!this.options.getLocalAuthList) {
        throw new ControlProtocolError("not-ready", "Local auth list is not supported.");
      }
      return { entries: this.options.getLocalAuthList() };
    }
    if (request.action === "upload-offline-transactions") {
      if (!this.options.uploadOfflineTransactions) {
        throw new ControlProtocolError("not-ready", "Offline transactions are not supported.");
      }
      return this.options.uploadOfflineTransactions().then((uploaded) => ({ uploaded }));
    }
    if (request.action === "queue-offline-transaction") {
      if (!this.options.queueOfflineTransaction) {
        throw new ControlProtocolError("not-ready", "Offline transactions are not supported.");
      }
      const tx = readOfflineTransaction(request.payload);
      this.options.queueOfflineTransaction(tx);
      return { queued: true };
    }
    if (request.action === "retry-start-transaction") {
      if (!this.options.retryStartTransaction) {
        throw new ControlProtocolError("not-ready", "Retry start is not supported.");
      }
      const { idTag, connectorId } = readRetryStart(request.payload);
      return this.options.retryStartTransaction(idTag, connectorId).then(() => ({ started: true }));
    }
    if (request.action === "retry-stop-transaction") {
      if (!this.options.retryStopTransaction) {
        throw new ControlProtocolError("not-ready", "Retry stop is not supported.");
      }
      return this.options.retryStopTransaction().then(() => ({ stopped: true }));
    }
    if (request.action === "local-start") {
      if (!this.options.localStart) {
        throw new ControlProtocolError("not-ready", "local-start is not supported.");
      }
      const { idTag, connectorId } = readRetryStart(request.payload);
      return this.options.localStart(idTag, connectorId).then(() => ({ started: true }));
    }
    if (request.action === "local-stop") {
      if (!this.options.localStop) {
        throw new ControlProtocolError("not-ready", "local-stop is not supported.");
      }
      const reason = readStopReason(request.payload);
      return this.options.localStop(reason).then(() => ({ stopped: true, reason }));
    }
    if (request.action === "set-connector-status") {
      if (!this.options.setConnectorStatus) {
        throw new ControlProtocolError("not-ready", "set-connector-status is not supported.");
      }
      const { status, errorCode } = readConnectorStatus(request.payload);
      return this.options.setConnectorStatus(status, errorCode).then(() => ({ status, errorCode: errorCode ?? "NoError" }));
    }
    if (request.action === "reset-connector-idle") {
      if (!this.options.resetToIdle) {
        throw new ControlProtocolError("not-ready", "reset-connector-idle is not supported.");
      }
      return this.options.resetToIdle().then(() => ({ reset: true }));
    }
    if (request.action === "restore-transaction-state") {
      if (!this.options.restoreTransactionState) {
        throw new ControlProtocolError("not-ready", "Restore transaction state is not supported.");
      }
      const state = readRestoreTransactionState(request.payload);
      this.options.restoreTransactionState(state);
      return { restored: true };
    }
    throw new ControlProtocolError("not-supported", `Unsupported simulator action ${request.action}.`);
  }

  private connectTarget(payload: unknown): Promise<{ state: "connected"; subprotocol: string }> {
    const url = readConnectUrl(payload);
    if (!this.options.connectOcpp) {
      throw new ControlProtocolError("not-ready", "OCPP session is not ready.");
    }
    return this.options.connectOcpp(url);
  }

  private disconnectTarget(payload: unknown): Promise<{ state: "disconnected" }> {
    if (!this.options.disconnectTarget) {
      throw new ControlProtocolError("not-ready", "OCPP session is not ready.");
    }
    return this.options.disconnectTarget(readRestore(payload));
  }

  private emitTarget(payload: unknown): Promise<{ status: "Accepted" }> {
    if (!this.options.emitOcpp) {
      throw new ControlProtocolError("not-ready", "OCPP session is not ready.");
    }
    const action = readEmitAction(payload);
    const connectorId = readOptionalConnector(payload);
    return this.options.emitOcpp(action, connectorId);
  }

  notify(action: "ocpp-frame" | "ocpp-state", payload: unknown): Promise<unknown> {
    if (!this.channel) {
      return Promise.reject(new ControlProtocolError("disconnected", "Simulator control is not connected."));
    }
    return this.channel.request(action, payload);
  }
}

function readFaultId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || typeof (payload as { id?: unknown }).id !== "string") {
    throw new ControlProtocolError("invalid-message", "clear-fault requires an id.");
  }
  return (payload as { id: string }).id;
}

function readConnectUrl(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "connect-ocpp requires a URL.");
  }
  const url = (payload as { url?: unknown }).url;
  const subprotocol = (payload as { subprotocol?: unknown }).subprotocol;
  if (typeof url !== "string" || url.length === 0) {
    throw new ControlProtocolError("invalid-message", "connect-ocpp requires a URL.");
  }
  if (subprotocol !== "ocpp1.6") {
    throw new ControlProtocolError("invalid-message", "connect-ocpp requires the ocpp1.6 subprotocol.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ControlProtocolError("invalid-message", "connect-ocpp URL is malformed.");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ControlProtocolError("invalid-message", "connect-ocpp URL must use ws: or wss:.");
  }
  return url;
}

function readRestore(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  return (payload as { restoreBootstrap?: unknown }).restoreBootstrap === true;
}

function readEmitAction(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || typeof (payload as { action?: unknown }).action !== "string") {
    throw new ControlProtocolError("invalid-message", "emit-ocpp requires an action.");
  }
  return (payload as { action: string }).action;
}

function readOptionalConnector(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const connectorId = (payload as { connectorId?: unknown }).connectorId;
  return typeof connectorId === "number" ? connectorId : undefined;
}

function readDelayMs(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "set-outbound-delay requires a delayMs.");
  }
  const delayMs = (payload as { delayMs?: unknown }).delayMs;
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new ControlProtocolError("invalid-message", `delayMs must be an integer from 0 to ${MAX_DELAY_MS}.`);
  }
  return delayMs;
}

function readLocalAuthList(payload: unknown): LocalAuthEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "set-local-auth-list requires entries.");
  }
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new ControlProtocolError("invalid-message", "entries must be an array.");
  }
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ControlProtocolError("invalid-message", `Entry ${index} must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.idTag !== "string" || e.idTag.length === 0) {
      throw new ControlProtocolError("invalid-message", `Entry ${index} must have an idTag.`);
    }
    const validStatuses = ["Accepted", "Blocked", "Expired", "Invalid", "ConcurrentTx"];
    if (typeof e.status !== "string" || !validStatuses.includes(e.status)) {
      throw new ControlProtocolError("invalid-message", `Entry ${index} must have a valid status.`);
    }
    return {
      idTag: e.idTag,
      status: e.status as LocalAuthEntry["status"],
      ...(typeof e.expiryDate === "string" ? { expiryDate: e.expiryDate } : {}),
    };
  });
}

function readOfflineTransaction(payload: unknown): OfflineTransaction {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "queue-offline-transaction requires transaction data.");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.localId !== "number" || !Number.isInteger(p.localId)) {
    throw new ControlProtocolError("invalid-message", "localId must be an integer.");
  }
  if (typeof p.connectorId !== "number" || !Number.isInteger(p.connectorId)) {
    throw new ControlProtocolError("invalid-message", "connectorId must be an integer.");
  }
  if (typeof p.idTag !== "string" || p.idTag.length === 0) {
    throw new ControlProtocolError("invalid-message", "idTag must be a non-empty string.");
  }
  if (typeof p.meterStart !== "number") {
    throw new ControlProtocolError("invalid-message", "meterStart must be a number.");
  }
  if (typeof p.meterStop !== "number") {
    throw new ControlProtocolError("invalid-message", "meterStop must be a number.");
  }
  if (typeof p.startTimestamp !== "string") {
    throw new ControlProtocolError("invalid-message", "startTimestamp must be a string.");
  }
  if (typeof p.stopTimestamp !== "string") {
    throw new ControlProtocolError("invalid-message", "stopTimestamp must be a string.");
  }
  if (typeof p.reason !== "string") {
    throw new ControlProtocolError("invalid-message", "reason must be a string.");
  }
  return {
    localId: p.localId,
    connectorId: p.connectorId,
    idTag: p.idTag,
    meterStart: p.meterStart,
    meterStop: p.meterStop,
    startTimestamp: p.startTimestamp,
    stopTimestamp: p.stopTimestamp,
    reason: p.reason,
  };
}

function openWebSocket(url: string): ControlSocket {
  return new WebSocket(url, [CONTROL_SUBPROTOCOL]);
}

function defaultSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}

export function localSimulatorController(faults: FaultEngine) {
  return {
    async armFault(rule: Parameters<FaultEngine["arm"]>[0]) {
      faults.arm(validateFaultRule(rule));
    },
    async clearFault(id: string) {
      return faults.clear(id);
    },
    async clearAllFaults() {
      faults.clearAll();
    },
    async listFaults() {
      return faults.list();
    },
  };
}

function readRetryStart(payload: unknown): { idTag: string; connectorId?: number } {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "retry-start-transaction requires idTag.");
  }
  const idTag = (payload as { idTag?: unknown }).idTag;
  if (typeof idTag !== "string" || idTag.length === 0) {
    throw new ControlProtocolError("invalid-message", "retry-start-transaction requires idTag.");
  }
  const connectorId = (payload as { connectorId?: unknown }).connectorId;
  if (connectorId !== undefined && (typeof connectorId !== "number" || !Number.isInteger(connectorId))) {
    throw new ControlProtocolError("invalid-message", "retry-start-transaction connectorId must be an integer.");
  }
  return { idTag, ...(typeof connectorId === "number" ? { connectorId } : {}) };
}

function readRestoreTransactionState(payload: unknown): {
  transactionId: number;
  idTag: string;
  connectorStatus?: string;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new ControlProtocolError("invalid-message", "restore-transaction-state requires transactionId and idTag.");
  }
  const transactionId = (payload as { transactionId?: unknown }).transactionId;
  const idTag = (payload as { idTag?: unknown }).idTag;
  if (typeof transactionId !== "number" || !Number.isInteger(transactionId)) {
    throw new ControlProtocolError("invalid-message", "restore-transaction-state requires transactionId.");
  }
  if (typeof idTag !== "string" || idTag.length === 0) {
    throw new ControlProtocolError("invalid-message", "restore-transaction-state requires idTag.");
  }
  const connectorStatus = (payload as { connectorStatus?: unknown }).connectorStatus;
  if (connectorStatus !== undefined && typeof connectorStatus !== "string") {
    throw new ControlProtocolError("invalid-message", "restore-transaction-state connectorStatus must be a string.");
  }
  return {
    transactionId,
    idTag,
    ...(typeof connectorStatus === "string" ? { connectorStatus } : {}),
  };
}

function readStopReason(payload: unknown): string {
  if (payload === undefined || payload === null || (typeof payload === "object" && !("reason" in (payload as object)))) {
    return "Local";
  }
  const reason = (payload as { reason?: unknown }).reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new ControlProtocolError("invalid-message", "local-stop reason must be a non-empty string.");
  }
  return reason;
}

function readConnectorStatus(payload: unknown): { status: string; errorCode?: string } {
  if (typeof payload !== "object" || payload === null || typeof (payload as { status?: unknown }).status !== "string") {
    throw new ControlProtocolError("invalid-message", "set-connector-status requires status.");
  }
  const status = (payload as { status: string }).status;
  const errorCode = (payload as { errorCode?: unknown }).errorCode;
  if (errorCode !== undefined && typeof errorCode !== "string") {
    throw new ControlProtocolError("invalid-message", "set-connector-status errorCode must be a string.");
  }
  return {
    status,
    ...(typeof errorCode === "string" ? { errorCode } : {}),
  };
}

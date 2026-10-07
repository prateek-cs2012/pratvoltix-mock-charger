import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SUBPROTOCOL,
  ControlChannel,
  ControlProtocolError,
  SIMULATOR_CAPABILITY,
  validateFaultRule,
  type ControlRequest,
} from "@pratvoltix/simulator-control";
import WebSocket from "ws";
import type { FaultEngine } from "./fault-engine.js";

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

  private handleRequest(request: ControlRequest): unknown {
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
      };
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

import { OcppConnection, transportFromWebSocket } from "@pratvoltix/ocpp";
import { ControlProtocolError, sanitizeCsmsUrl, type ReconnectStormConfig } from "@pratvoltix/simulator-control";
import WebSocket from "ws";
import type { FaultEngine } from "./fault-engine.js";
import { MockChargePoint, type ChargePointState, type ConnectorStatus, type LocalAuthEntry, type OfflineTransaction } from "./mock-charge-point.js";

const CONNECT_TIMEOUT_MS = 8_000;

export interface OcppSocket {
  protocol: string;
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: () => void): void;
}

export interface OcppSessionOptions {
  identity: string;
  bootstrapUrl: string;
  vendor?: string;
  model?: string;
  faults: FaultEngine;
  notify: (action: "ocpp-frame" | "ocpp-state", payload: unknown) => Promise<unknown>;
  openSocket?: (url: string) => OcppSocket;
  log?: (message: string) => void;
}

export class OcppSession {
  private socket: OcppSocket | undefined;
  private chargePoint: MockChargePoint | undefined;
  private generation = 0;
  private holdingExternal = false;
  private suppressReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private persistedState: ChargePointState | undefined;
  private reconnectStorm: ReconnectStormConfig | undefined;
  private stormBurstRemaining = 0;

  constructor(private readonly options: OcppSessionOptions) {}

  setReconnectStorm(config: ReconnectStormConfig | undefined): void {
    this.reconnectStorm = config;
    if (config) {
      this.stormBurstRemaining = config.burstCount;
    } else {
      this.stormBurstRemaining = 0;
      this.clearReconnect();
    }
  }

  getReconnectStorm(): ReconnectStormConfig | undefined {
    return this.reconnectStorm;
  }

  getPersistedState(): ChargePointState | undefined {
    return this.persistedState;
  }

  setOutboundDelay(delayMs: number): void {
    this.chargePoint?.setOutboundDelay(delayMs);
  }

  getOutboundDelay(): number {
    return this.chargePoint?.getOutboundDelay() ?? 0;
  }

  setLocalAuthList(entries: LocalAuthEntry[]): void {
    this.chargePoint?.setLocalAuthList(entries);
  }

  getLocalAuthList(): LocalAuthEntry[] {
    return this.chargePoint?.getLocalAuthList() ?? [];
  }

  /** Clear active tx + force Available (and persist) so the next catalog case starts clean. */
  async resetToIdle(): Promise<void> {
    this.chargePoint?.resetToIdle();
    if (this.chargePoint) {
      this.persistedState = this.chargePoint.getState();
      try {
        await this.chargePoint.notifyAvailable();
      } catch {
        // Socket may be down; persisted Available is enough for the next announce.
      }
    } else if (this.persistedState) {
      this.persistedState = {
        ...this.persistedState,
        transactionId: null,
        idTag: null,
        connectorStatus: "Available",
      };
    }
  }

  async localStart(idTag: string, connectorId?: number): Promise<void> {
    if (!this.chargePoint) {
      throw new ControlProtocolError("not-ready", "OCPP session is not connected.");
    }
    await this.chargePoint.localStart(idTag, connectorId);
    this.persistedState = this.chargePoint.getState();
  }

  async localStop(reason?: string): Promise<void> {
    if (!this.chargePoint) {
      throw new ControlProtocolError("not-ready", "OCPP session is not connected.");
    }
    await this.chargePoint.localStop(reason);
    this.persistedState = this.chargePoint.getState();
  }

  async setConnectorStatus(status: string, errorCode?: string): Promise<void> {
    if (!this.chargePoint) {
      throw new ControlProtocolError("not-ready", "OCPP session is not connected.");
    }
    const allowed: ConnectorStatus[] = [
      "Available",
      "Preparing",
      "Charging",
      "SuspendedEVSE",
      "SuspendedEV",
      "Finishing",
      "Reserved",
      "Unavailable",
      "Faulted",
    ];
    if (!allowed.includes(status as ConnectorStatus)) {
      throw new ControlProtocolError("invalid-message", `Unsupported connector status ${status}.`);
    }
    await this.chargePoint.setConnectorStatus(status as ConnectorStatus, errorCode);
    this.persistedState = this.chargePoint.getState();
  }

  async uploadOfflineTransactions(): Promise<number> {
    return this.chargePoint?.uploadOfflineTransactions() ?? 0;
  }

  queueOfflineTransaction(tx: OfflineTransaction): void {
    this.chargePoint?.queueOfflineTransaction(tx);
  }

  async retryStartTransaction(idTag: string, connectorId?: number): Promise<void> {
    if (!this.chargePoint) {
      throw new Error("Charge point is not connected");
    }
    await this.chargePoint.beginTransactionForLab(idTag, connectorId);
  }

  async retryStopTransaction(): Promise<void> {
    if (!this.chargePoint) {
      throw new Error("Charge point is not connected");
    }
    await this.chargePoint.finishTransactionForLab();
  }

  restoreTransactionState(state: {
    transactionId: number;
    idTag: string;
    connectorStatus?: string;
  }): void {
    this.chargePoint?.restoreTransactionState({
      transactionId: state.transactionId,
      idTag: state.idTag,
      ...(state.connectorStatus
        ? { connectorStatus: state.connectorStatus as ConnectorStatus }
        : {}),
    });
  }

  start(): void {
    void this.open(this.options.bootstrapUrl, false).catch((error: unknown) => {
      this.logIssue(error);
    });
  }

  stop(): void {
    this.stopped = true;
    this.suppressReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
  }

  activeSocketCount(): number {
    return this.socket && this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== WebSocket.CLOSING ? 1 : 0;
  }

  async connect(url: string): Promise<{ state: "connected"; subprotocol: string }> {
    this.holdingExternal = true;
    this.clearReconnect();
    this.persistedState = undefined;
    await this.settleClose();
    return this.open(url, true);
  }

  async disconnect(restoreBootstrap: boolean): Promise<{ state: "disconnected" }> {
    this.holdingExternal = !restoreBootstrap;
    this.clearReconnect();
    this.persistedState = undefined;
    await this.settleClose();
    await this.notifyState({ state: "disconnected" });
    if (restoreBootstrap && !this.stopped) {
      void this.open(this.options.bootstrapUrl, false).catch((error: unknown) => {
        this.logIssue(error);
      });
    }
    return { state: "disconnected" };
  }

  async emit(action: string, connectorId?: number): Promise<{ status: "Accepted" }> {
    void connectorId;
    if (!this.chargePoint || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new ControlProtocolError("not-ready", "OCPP socket is not connected.");
    }
    await this.chargePoint.emit(action);
    return { status: "Accepted" };
  }

  private async open(url: string, external: boolean): Promise<{ state: "connected"; subprotocol: string }> {
    if (this.stopped) {
      throw new ControlProtocolError("disconnected", "OCPP session is stopped.");
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      await this.settleClose();
    }
    const generation = ++this.generation;
    this.suppressReconnect = false;
    await this.notifyState({ state: "connecting" });
    this.options.log?.(`Connecting ${this.options.identity} to ${sanitizeCsmsUrl(url)}`);
    const socket = (this.options.openSocket ?? openWebSocket)(url);
    this.socket = socket;
    this.options.log?.(`OCPP sockets for ${this.options.identity}: ${this.activeSocketCount()}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, subprotocol?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (generation !== this.generation) {
          reject(new ControlProtocolError("disconnected", "OCPP target changed before the socket opened."));
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({ state: "connected", subprotocol: subprotocol ?? "" });
      };
      const timer = setTimeout(() => {
        if (generation !== this.generation) {
          return;
        }
        socket.close();
        void this.notifyState({ state: "failed", error: "External CSMS connection failed." });
        finish(new ControlProtocolError("timeout", "External CSMS connection failed."));
      }, CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        if (generation !== this.generation) {
          socket.close();
          return;
        }
        if (socket.protocol !== "ocpp1.6") {
          socket.close();
          void this.notifyState({ state: "failed", error: "Negotiated subprotocol was not ocpp1.6." });
          finish(new ControlProtocolError("invalid-message", "Negotiated subprotocol was not ocpp1.6."));
          return;
        }
        this.attach(socket, generation);
        void this.notifyState({ state: "connected", subprotocol: socket.protocol });
        finish(undefined, socket.protocol);
      });
      socket.on("error", () => {
        if (generation !== this.generation) {
          return;
        }
        void this.notifyState({ state: "failed", error: "External CSMS connection failed." });
        finish(new ControlProtocolError("handler-failed", "External CSMS connection failed."));
      });
      socket.on("close", () => {
        if (generation !== this.generation) {
          finish(new ControlProtocolError("disconnected", "OCPP target changed before the socket opened."));
          return;
        }
        if (this.socket === socket) {
          this.socket = undefined;
          if (this.chargePoint) {
            this.persistedState = this.chargePoint.getState();
          }
          this.chargePoint?.close();
          this.chargePoint = undefined;
        }
        if (!settled) {
          void this.notifyState({ state: "failed", error: "External CSMS connection failed." });
          finish(new ControlProtocolError("disconnected", "External CSMS connection failed."));
          return;
        }
        void this.notifyState({ state: "disconnected" });
        if (!this.suppressReconnect && !this.holdingExternal && !external) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private attach(socket: OcppSocket, generation: number): void {
    const mirrorSend = socket.send.bind(socket);
    socket.send = (data: string) => {
      void this.mirror("charge-point-to-csms", data);
      mirrorSend(data);
    };
    socket.on("message", (data) => {
      void this.mirror("csms-to-charge-point", String(data));
    });
    const connection = new OcppConnection(transportFromWebSocket(socket), {
      onProtocolError: (error) => this.options.log?.(`OCPP protocol error: ${error.message}`),
    });
    const chargePoint = new MockChargePoint(
      connection,
      {
        identity: this.options.identity,
        vendor: this.options.vendor ?? "Pratvoltix",
        model: this.options.model ?? "Lab-One",
        initialState: this.persistedState,
      },
      this.options.faults,
      {
        disconnectOcpp: () => socket.close(),
        sendRawOcpp: (data: string) => {
          try {
            socket.send(data);
          } catch {
            // Socket may be closed
          }
        },
      },
    );
    this.chargePoint = chargePoint;
    void chargePoint.announce().then(
      () => {
        if (generation === this.generation) {
          this.options.log?.(`${this.options.identity} accepted by CSMS`);
          this.continueStormIfNeeded(generation);
        }
      },
      (error: unknown) => {
        if (generation !== this.generation) {
          return;
        }
        this.logIssue(error);
        chargePoint.close();
        socket.close();
      },
    );
  }

  private async settleClose(): Promise<void> {
    const socket = this.socket;
    this.chargePoint?.close();
    this.chargePoint = undefined;
    this.suppressReconnect = true;
    this.generation += 1;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.socket = undefined;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
    if (this.socket === socket) {
      this.socket = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.holdingExternal) {
      return;
    }
    const delayMs = this.reconnectStorm ? this.reconnectStorm.burstDelayMs : 2_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open(this.options.bootstrapUrl, false).catch((error: unknown) => {
        this.logIssue(error);
      });
    }, delayMs);
  }

  /** After a successful Boot/announce, keep dropping while storm slots remain. */
  private continueStormIfNeeded(generation: number): void {
    if (!this.reconnectStorm || this.stopped || generation !== this.generation) {
      return;
    }
    if (this.stormBurstRemaining > 0) {
      this.stormBurstRemaining -= 1;
    }
    if (this.stormBurstRemaining > 0) {
      const delayMs = this.reconnectStorm.burstDelayMs;
      this.clearReconnect();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.reconnectStorm || generation !== this.generation) {
          return;
        }
        this.options.log?.(`${this.options.identity} storm drop (${this.stormBurstRemaining} remaining)`);
        try {
          this.socket?.close();
        } catch {
          // ignore
        }
      }, delayMs);
      return;
    }
    // Burst exhausted — pause then start another burst until clearReconnectStorm.
    const intervalMs = this.reconnectStorm.intervalMs;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.reconnectStorm || generation !== this.generation) {
        return;
      }
      this.stormBurstRemaining = this.reconnectStorm.burstCount;
      this.continueStormIfNeeded(generation);
    }, intervalMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async mirror(direction: "charge-point-to-csms" | "csms-to-charge-point", raw: string): Promise<void> {
    await this.notifyStateFrame("ocpp-frame", { direction, raw });
  }

  private async notifyState(payload: { state: string; subprotocol?: string; error?: string }): Promise<void> {
    await this.notifyStateFrame("ocpp-state", payload);
  }

  private async notifyStateFrame(action: "ocpp-frame" | "ocpp-state", payload: unknown): Promise<void> {
    try {
      await this.options.notify(action, payload);
    } catch {
      // A control-channel miss must not change the OCPP socket.
    }
  }

  private logIssue(error: unknown): void {
    const message = error instanceof Error ? error.message : "OCPP socket error";
    if (message.includes("://") || message.includes("@")) {
      this.options.log?.("OCPP socket error");
      return;
    }
    this.options.log?.(message);
  }
}

function openWebSocket(url: string): OcppSocket {
  return new WebSocket(url, ["ocpp1.6"]);
}

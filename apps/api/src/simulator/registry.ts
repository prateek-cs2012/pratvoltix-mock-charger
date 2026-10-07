import {
  ControlProtocolError,
  readClearFaultResult,
  readFaultSummaries,
  validateReconnectStormConfig,
  type ControlChannel,
  type ExtendedSimulatorController,
  type FaultRule,
  type FaultSummary,
  type HelloPayload,
  type LocalAuthEntry,
  type OfflineTransactionEntry,
  type ReconnectStormConfig,
  type ReconnectStormController,
  type SimulatorController,
} from "@pratvoltix/simulator-control";

export interface CleanupStatus {
  ok: boolean;
  at: string;
  error?: string;
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
  activeFaults: FaultSummary[];
  lastCleanup: CleanupStatus | null;
}

export interface OcppWatch {
  onFrame(payload: unknown): void;
  onState(payload: unknown): void;
}

interface SimulatorSession {
  hello: HelloPayload;
  channel: ControlChannel;
  closeSocket: () => void;
  connected: boolean;
  connectedAt: string;
  lastSeenAt: string;
  faults: FaultSummary[];
  lastCleanup?: CleanupStatus;
}

export class SimulatorRegistry {
  private readonly sessions = new Map<string, SimulatorSession>();
  private readonly ocppWatchers = new Map<string, OcppWatch>();

  /**
   * A newer control connection for the same identity replaces the previous one.
   * The previous socket is closed and its pending requests fail.
   */
  accept(hello: HelloPayload, channel: ControlChannel, closeSocket: () => void): void {
    const previous = this.sessions.get(hello.chargePointIdentity);
    if (previous && previous.channel !== channel) {
      previous.connected = false;
      previous.closeSocket();
      previous.channel.close();
    }
    const now = new Date().toISOString();
    this.sessions.set(hello.chargePointIdentity, {
      hello,
      channel,
      closeSocket,
      connected: true,
      connectedAt: now,
      lastSeenAt: now,
      faults: [],
      ...(previous?.lastCleanup ? { lastCleanup: previous.lastCleanup } : {}),
    });
  }

  disconnect(identity: string, channel: ControlChannel): void {
    const current = this.sessions.get(identity);
    if (!current || current.channel !== channel || !current.connected) {
      return;
    }
    current.connected = false;
    current.lastSeenAt = new Date().toISOString();
    current.channel.close();
  }

  get(identity: string): SimulatorStatus | undefined {
    const session = this.sessions.get(identity);
    return session ? present(session) : undefined;
  }

  list(): SimulatorStatus[] {
    return [...this.sessions.values()].map(present).sort((left, right) => left.identity.localeCompare(right.identity));
  }

  controller(identity: string): SimulatorController {
    const session = this.requireConnected(identity);
    return {
      armFault: async (rule: FaultRule) => {
        await session.channel.request("arm-fault", rule);
        session.lastSeenAt = new Date().toISOString();
        session.faults = [...session.faults.filter((fault) => fault.id !== rule.id), {
          id: rule.id,
          action: rule.match.action,
          occurrence: rule.match.occurrence,
          effectType: rule.effect.type,
        }];
      },
      clearFault: async (id: string) => {
        const payload = await session.channel.request("clear-fault", { id });
        const result = readClearFaultResult(payload);
        session.lastSeenAt = new Date().toISOString();
        if (result.cleared || result.alreadyConsumed) {
          session.faults = session.faults.filter((fault) => fault.id !== id);
        }
        return result;
      },
      clearAllFaults: async () => {
        await session.channel.request("clear-all-faults", {});
        session.lastSeenAt = new Date().toISOString();
        session.faults = [];
      },
      listFaults: async () => this.refreshFaults(session),
    };
  }

  reconnectStormController(identity: string): ReconnectStormController {
    const session = this.requireConnected(identity);
    return {
      setReconnectStorm: async (config: ReconnectStormConfig) => {
        const validated = validateReconnectStormConfig(config);
        await session.channel.request("set-reconnect-storm", validated);
        session.lastSeenAt = new Date().toISOString();
      },
      clearReconnectStorm: async () => {
        await session.channel.request("clear-reconnect-storm", {});
        session.lastSeenAt = new Date().toISOString();
      },
    };
  }

  extendedSimulatorController(identity: string): ExtendedSimulatorController {
    const registry = this;
    return {
      setOutboundDelay: async (delayMs: number) => {
        await registry.setOutboundDelay(identity, delayMs);
      },
      clearOutboundDelay: async () => {
        await registry.clearOutboundDelay(identity);
      },
      setLocalAuthList: async (entries: LocalAuthEntry[]) => {
        await registry.setLocalAuthList(identity, entries);
      },
      getLocalAuthList: async () => {
        return registry.getLocalAuthList(identity);
      },
      queueOfflineTransaction: async (tx: OfflineTransactionEntry) => {
        const session = registry.requireConnected(identity);
        await session.channel.request("queue-offline-transaction", tx);
        session.lastSeenAt = new Date().toISOString();
      },
      uploadOfflineTransactions: async () => {
        return registry.uploadOfflineTransactions(identity);
      },
    };
  }

  async setOutboundDelay(identity: string, delayMs: number): Promise<void> {
    const session = this.requireConnected(identity);
    await session.channel.request("set-outbound-delay", { delayMs });
    session.lastSeenAt = new Date().toISOString();
  }

  async clearOutboundDelay(identity: string): Promise<void> {
    const session = this.requireConnected(identity);
    await session.channel.request("clear-outbound-delay", {});
    session.lastSeenAt = new Date().toISOString();
  }

  async setLocalAuthList(identity: string, entries: Array<{ idTag: string; status: string; expiryDate?: string }>): Promise<void> {
    const session = this.requireConnected(identity);
    await session.channel.request("set-local-auth-list", { entries });
    session.lastSeenAt = new Date().toISOString();
  }

  async getLocalAuthList(identity: string): Promise<Array<{ idTag: string; status: string; expiryDate?: string }>> {
    const session = this.requireConnected(identity);
    const payload = await session.channel.request("get-local-auth-list", {});
    session.lastSeenAt = new Date().toISOString();
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { entries?: unknown }).entries)) {
      return [];
    }
    return (payload as { entries: Array<{ idTag: string; status: string; expiryDate?: string }> }).entries;
  }

  async uploadOfflineTransactions(identity: string): Promise<number> {
    const session = this.requireConnected(identity);
    const payload = await session.channel.request("upload-offline-transactions", {});
    session.lastSeenAt = new Date().toISOString();
    if (typeof payload !== "object" || payload === null || typeof (payload as { uploaded?: unknown }).uploaded !== "number") {
      return 0;
    }
    return (payload as { uploaded: number }).uploaded;
  }

  async ensureClean(identity: string): Promise<void> {
    const session = this.requireConnected(identity);
    try {
      await session.channel.request("clear-all-faults", {});
      const faults = await this.refreshFaults(session);
      if (faults.length > 0) {
        throw new ControlProtocolError("not-clean", `Simulator ${identity} still has ${faults.length} active faults.`);
      }
      this.recordCleanup(identity, { ok: true, at: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cleanup failed";
      this.recordCleanup(identity, { ok: false, at: new Date().toISOString(), error: message });
      throw error;
    }
  }

  async finish(identity: string): Promise<void> {
    const session = this.sessions.get(identity);
    if (!session?.connected) {
      this.recordCleanup(identity, {
        ok: false,
        at: new Date().toISOString(),
        error: `Simulator ${identity} disconnected before cleanup.`,
      });
      return;
    }
    try {
      await session.channel.request("clear-all-faults", {});
      const faults = await this.refreshFaults(session);
      if (faults.length > 0) {
        throw new ControlProtocolError("not-clean", `Simulator ${identity} still has ${faults.length} active faults.`);
      }
      this.recordCleanup(identity, { ok: true, at: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cleanup failed";
      this.recordCleanup(identity, { ok: false, at: new Date().toISOString(), error: message });
    }
  }

  watchOcpp(identity: string, watch: OcppWatch): void {
    this.ocppWatchers.set(identity, watch);
  }

  clearOcppWatch(identity: string): void {
    this.ocppWatchers.delete(identity);
  }

  ingestOcppFrame(identity: string, payload: unknown): void {
    this.ocppWatchers.get(identity)?.onFrame(payload);
  }

  ingestOcppState(identity: string, payload: unknown): void {
    this.ocppWatchers.get(identity)?.onState(payload);
  }

  async connectOcpp(identity: string, url: string): Promise<{ state: "connected"; subprotocol: string }> {
    const session = this.requireConnected(identity);
    const payload = await session.channel.request("connect-ocpp", { url, subprotocol: "ocpp1.6" }, 12_000);
    if (!isConnectedPayload(payload)) {
      throw new ControlProtocolError("handler-failed", "External CSMS connection failed.");
    }
    return { state: "connected", subprotocol: "ocpp1.6" };
  }

  async restoreBootstrap(identity: string): Promise<void> {
    const session = this.sessions.get(identity);
    if (!session?.connected) {
      return;
    }
    await session.channel.request("disconnect-ocpp", { restoreBootstrap: true }, 10_000);
  }

  async emitOcpp(identity: string, action: string, connectorId?: number): Promise<{ status: "Accepted" }> {
    const session = this.requireConnected(identity);
    const payload = await session.channel.request(
      "emit-ocpp",
      { action, ...(connectorId === undefined ? {} : { connectorId }) },
      10_000,
    );
    if (!isRecord(payload) || payload["status"] !== "Accepted") {
      throw new ControlProtocolError("handler-failed", "Charger did not accept the emitted message.");
    }
    return { status: "Accepted" };
  }

  async refresh(identity: string): Promise<SimulatorStatus | undefined> {
    const session = this.sessions.get(identity);
    if (!session) {
      return undefined;
    }
    if (session.connected) {
      try {
        await this.refreshFaults(session);
      } catch {
        // Keep the last confirmed summary when the control call fails.
      }
    }
    return present(session);
  }

  private async refreshFaults(session: SimulatorSession): Promise<FaultSummary[]> {
    const payload = await session.channel.request("list-faults", {});
    session.faults = readFaultSummaries(payload);
    session.lastSeenAt = new Date().toISOString();
    return session.faults;
  }

  private requireConnected(identity: string): SimulatorSession {
    const session = this.sessions.get(identity);
    if (!session?.connected) {
      throw new ControlProtocolError("disconnected", `Simulator ${identity} is not connected.`);
    }
    return session;
  }

  private recordCleanup(identity: string, status: CleanupStatus): void {
    const session = this.sessions.get(identity);
    if (!session) {
      return;
    }
    session.lastCleanup = status;
    if (status.ok) {
      session.faults = [];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConnectedPayload(value: unknown): boolean {
  return isRecord(value) && value["state"] === "connected" && value["subprotocol"] === "ocpp1.6";
}

function present(session: SimulatorSession): SimulatorStatus {
  return {
    identity: session.hello.chargePointIdentity,
    connected: session.connected,
    protocolVersion: session.hello.protocolVersion,
    simulatorName: session.hello.simulatorName,
    simulatorVersion: session.hello.simulatorVersion,
    capabilities: [...session.hello.capabilities],
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    activeFaults: session.faults.map((fault) => ({ ...fault })),
    lastCleanup: session.lastCleanup ? { ...session.lastCleanup } : null,
  };
}

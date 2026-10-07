import {
  Ocpp16Action,
  Ocpp16ErrorCode,
  OcppConnection,
  OcppResponseError,
  readNumber,
  readString,
  type InboundCall,
} from "@pratvoltix/ocpp";
import type { FaultEffect } from "@pratvoltix/simulator-control";
import type { FaultEngine } from "./fault-engine.js";

export type ConnectorStatus = "Available" | "Preparing" | "Charging" | "SuspendedEVSE" | "SuspendedEV" | "Finishing" | "Reserved" | "Unavailable" | "Faulted";

export interface ChargePointState {
  transactionId: number | null;
  connectorStatus: ConnectorStatus;
  meterWh: number;
  idTag: string | null;
}

export interface OfflineTransaction {
  localId: number;
  connectorId: number;
  idTag: string;
  meterStart: number;
  meterStop: number;
  startTimestamp: string;
  stopTimestamp: string;
  reason: string;
}

export interface LocalAuthEntry {
  idTag: string;
  status: "Accepted" | "Blocked" | "Expired" | "Invalid" | "ConcurrentTx";
  expiryDate?: string;
}

export interface MockChargePointOptions {
  identity: string;
  vendor?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  connectorId?: number;
  initialState?: ChargePointState;
}

interface ConfigurationKey {
  key: string;
  readonly: boolean;
  value: string;
}

export interface MockChargePointHooks {
  disconnectOcpp?: () => void;
  sendRawOcpp?: (data: string) => void;
}

export class MockChargePoint {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private meterWh: number;
  private transactionId: number | null;
  private connectorStatus: ConnectorStatus;
  private idTag: string | null;
  private heartbeatInterval = 60;
  private readonly connectorId: number;

  private lastStartTxKey: string | null = null;
  private lastStartTxResponse: { transactionId: number } | null = null;
  private lastStopTxId: number | null = null;
  private lastStopTxResponse: Record<string, unknown> | null = null;

  private localAuthList: LocalAuthEntry[] = [];
  private localAuthListVersion = 0;
  private offlineQueue: OfflineTransaction[] = [];
  private authorizationCache = new Map<string, LocalAuthEntry>();
  private outboundDelayMs = 0;

  private reservationId: number | null = null;
  private availabilityScheduled = false;
  private chargingProfiles = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly connection: OcppConnection,
    private readonly options: MockChargePointOptions,
    private readonly faults?: FaultEngine,
    private readonly hooks: MockChargePointHooks = {},
  ) {
    this.connectorId = options.connectorId ?? 1;
    const initialState = options.initialState;
    this.transactionId = initialState?.transactionId ?? null;
    this.connectorStatus = initialState?.connectorStatus ?? "Available";
    this.meterWh = initialState?.meterWh ?? 1_000;
    this.idTag = initialState?.idTag ?? null;
    this.connection.onCall((call) => this.handleCall(call));
  }

  setOutboundDelay(delayMs: number): void {
    this.outboundDelayMs = delayMs;
  }

  getOutboundDelay(): number {
    return this.outboundDelayMs;
  }

  setLocalAuthList(entries: LocalAuthEntry[]): void {
    this.localAuthList = [...entries];
    this.authorizationCache.clear();
    for (const entry of entries) {
      this.authorizationCache.set(entry.idTag, entry);
    }
  }

  getLocalAuthList(): LocalAuthEntry[] {
    return [...this.localAuthList];
  }

  getLocalListVersion(): number {
    return this.localAuthListVersion;
  }

  getOfflineQueue(): OfflineTransaction[] {
    return [...this.offlineQueue];
  }

  clearOfflineQueue(): void {
    this.offlineQueue = [];
  }

  getState(): ChargePointState {
    return {
      transactionId: this.transactionId,
      connectorStatus: this.connectorStatus,
      meterWh: this.meterWh,
      idTag: this.idTag,
    };
  }

  hasActiveTransaction(): boolean {
    return this.transactionId !== null;
  }

  /** Lab helper: run the same Start path as RemoteStart follow-on (for idempotency tests). */
  async beginTransactionForLab(idTag: string, connectorId?: number): Promise<void> {
    await this.beginTransaction(idTag, connectorId ?? this.connectorId);
  }

  /** Lab helper: run the Stop path (for idempotency tests). */
  async finishTransactionForLab(reason = "Remote"): Promise<void> {
    await this.finishTransaction(reason);
  }

  /**
   * Lab helper: restore active transaction fields without clearing Start/Stop caches.
   * Used to re-enter finishTransaction after a successful Stop cleared transactionId.
   */
  restoreTransactionState(state: {
    transactionId: number;
    idTag: string;
    connectorStatus?: ConnectorStatus;
  }): void {
    this.transactionId = state.transactionId;
    this.idTag = state.idTag;
    this.connectorStatus = state.connectorStatus ?? "Charging";
  }

  /** Lab cleanup: drop any active tx and mark Available without CSMS round-trips. */
  resetToIdle(): void {
    this.transactionId = null;
    this.idTag = null;
    this.connectorStatus = "Available";
    this.lastStopTxId = null;
    this.lastStopTxResponse = null;
    this.setOutboundDelay(0);
  }

  /** Best-effort StatusNotification Available for CSMS/lab peer visibility. */
  async notifyAvailable(): Promise<void> {
    this.connectorStatus = "Available";
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Available"));
  }

  /**
   * Local (cable) start: Preparing → Authorize/StartTransaction → Charging.
   * Not driven by RemoteStartTransaction.
   */
  async localStart(idTag: string, connectorId?: number): Promise<void> {
    if (this.transactionId !== null) {
      throw new Error("Cannot local-start while a transaction is active");
    }
    const targetConnector = connectorId ?? this.connectorId;
    this.connectorStatus = "Preparing";
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Preparing"));
    await this.beginTransaction(idTag, targetConnector);
  }

  /**
   * Local stop with an explicit StopTransaction.reason (Local, EVDisconnected, …).
   * Emits Finishing before Stop, then Available.
   */
  async localStop(reason = "Local"): Promise<void> {
    await this.finishTransaction(reason);
  }

  /** Force a StatusNotification (Suspended*, Faulted, …) without ending the tx. */
  async setConnectorStatus(status: ConnectorStatus, errorCode = "NoError"): Promise<void> {
    this.connectorStatus = status;
    await this.connection.call(Ocpp16Action.StatusNotification, {
      ...this.statusPayload(status),
      errorCode,
    });
  }

  async announce(): Promise<void> {
    const boot = await this.connection.call<{ status?: string; interval?: number }>(Ocpp16Action.BootNotification, {
      chargePointVendor: this.options.vendor ?? "Pratvoltix",
      chargePointModel: this.options.model ?? "Lab-One",
      chargePointSerialNumber: this.options.serialNumber ?? this.options.identity,
      firmwareVersion: this.options.firmwareVersion ?? "0.1.0",
    });

    if (boot.status === "Accepted" && typeof boot.interval === "number" && boot.interval >= 0) {
      this.heartbeatInterval = boot.interval;
    }
    this.scheduleHeartbeat();

    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload(this.connectorStatus));
  }

  async emit(action: string): Promise<void> {
    await this.sendTriggered(action);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async handleCall(call: InboundCall): Promise<Record<string, unknown>> {
    let effect: FaultEffect | undefined;
    try {
      effect = this.faults?.take(call.action);
    } catch (error) {
      console.error("Fault engine failed; handling the call normally", error);
      effect = undefined;
    }
    if (effect?.type === "delay") {
      await delay(effect.delayMs);
    } else if (effect?.type === "call-result") {
      return effect.payload;
    } else if (effect?.type === "call-error") {
      throw new OcppResponseError(effect.errorCode, effect.description, effect.details ?? {});
    } else if (effect?.type === "suppress-response") {
      return new Promise(() => undefined);
    } else if (effect?.type === "disconnect") {
      try {
        this.hooks.disconnectOcpp?.();
      } catch (error) {
        console.error("OCPP disconnect fault failed", error);
      }
      return new Promise(() => undefined);
    } else if (effect?.type === "malformed-response") {
      try {
        this.hooks.sendRawOcpp?.(effect.rawPayload);
      } catch (error) {
        console.error("Malformed response injection failed", error);
      }
      return new Promise(() => undefined);
    }

    switch (call.action) {
      case Ocpp16Action.TriggerMessage:
        return this.trigger(call);
      case Ocpp16Action.GetConfiguration:
        return { configurationKey: this.filterConfiguration(call.payload["key"]) };
      case Ocpp16Action.ChangeConfiguration:
        return this.changeConfiguration(call);
      case Ocpp16Action.RemoteStartTransaction:
        return this.remoteStart(call);
      case Ocpp16Action.RemoteStopTransaction:
        return this.remoteStop(call);
      case Ocpp16Action.Reset:
        return this.reset(call);
      case Ocpp16Action.UnlockConnector:
        return { status: "Unlocked" };
      case Ocpp16Action.ClearCache:
        this.authorizationCache.clear();
        return { status: "Accepted" };
      case Ocpp16Action.DataTransfer:
        return { status: "Rejected" };
      case Ocpp16Action.SendLocalList:
        return this.handleSendLocalList(call);
      case Ocpp16Action.GetLocalListVersion:
        return { listVersion: this.localAuthListVersion };
      case Ocpp16Action.ChangeAvailability:
        return this.changeAvailability(call);
      case Ocpp16Action.ReserveNow:
        return this.reserveNow(call);
      case Ocpp16Action.CancelReservation:
        return this.cancelReservation(call);
      case Ocpp16Action.SetChargingProfile:
        return this.setChargingProfile(call);
      case Ocpp16Action.ClearChargingProfile:
        return this.clearChargingProfile(call);
      case Ocpp16Action.GetCompositeSchedule:
        return this.getCompositeSchedule(call);
      case Ocpp16Action.UpdateFirmware:
        return this.updateFirmware(call);
      case Ocpp16Action.GetDiagnostics:
        return this.getDiagnostics(call);
      default:
        throw new OcppResponseError(Ocpp16ErrorCode.NotSupported, `Unsupported action ${call.action}`);
    }
  }

  private trigger(call: InboundCall): Record<string, unknown> {
    const requested = readString(call.payload, "requestedMessage");
    const supported = new Set<string>([
      Ocpp16Action.BootNotification,
      Ocpp16Action.Heartbeat,
      Ocpp16Action.StatusNotification,
      Ocpp16Action.MeterValues,
    ]);
    if (!requested || !supported.has(requested)) {
      return { status: "NotImplemented" };
    }

    setTimeout(() => {
      void this.sendTriggered(requested).catch((error: unknown) => {
        console.error(`Triggered ${requested} failed`, error);
      });
    }, 0);
    return { status: "Accepted" };
  }

  private async sendTriggered(requested: string): Promise<void> {
    if (requested === Ocpp16Action.BootNotification) {
      await this.connection.call(Ocpp16Action.BootNotification, {
        chargePointVendor: this.options.vendor ?? "Pratvoltix",
        chargePointModel: this.options.model ?? "Lab-One",
        chargePointSerialNumber: this.options.serialNumber ?? this.options.identity,
        firmwareVersion: this.options.firmwareVersion ?? "0.1.0",
      });
      return;
    }
    if (requested === Ocpp16Action.Heartbeat) {
      await this.connection.call(Ocpp16Action.Heartbeat, {});
      return;
    }
    if (requested === Ocpp16Action.StatusNotification) {
      await this.connection.call(
        Ocpp16Action.StatusNotification,
        this.statusPayload(this.connectorStatus),
      );
      return;
    }
    await this.connection.call(Ocpp16Action.MeterValues, {
      connectorId: this.connectorId,
      ...(this.transactionId === null ? {} : { transactionId: this.transactionId }),
      meterValue: [this.sample()],
    });
  }

  private remoteStart(call: InboundCall): Record<string, unknown> {
    if (this.transactionId !== null) {
      return { status: "Rejected" };
    }
    const idTag = readString(call.payload, "idTag");
    if (!idTag) {
      return { status: "Rejected" };
    }
    const connectorId = readNumber(call.payload, "connectorId") ?? this.connectorId;
    setTimeout(() => {
      void this.beginTransaction(idTag, connectorId).catch((error: unknown) => {
        console.error("Remote start failed", error);
      });
    }, 0);
    return { status: "Accepted" };
  }

  private async beginTransaction(idTag: string, connectorId: number): Promise<void> {
    if (this.outboundDelayMs > 0) {
      await delay(this.outboundDelayMs);
    }

    let authStatus: string | undefined;
    const cachedAuth = this.authorizationCache.get(idTag);
    if (cachedAuth) {
      authStatus = cachedAuth.status;
    } else {
      const authorize = await this.connection.call<{ idTagInfo?: { status?: string } }>(Ocpp16Action.Authorize, { idTag });
      authStatus = authorize.idTagInfo?.status;
      if (authStatus === "Accepted") {
        this.authorizationCache.set(idTag, { idTag, status: "Accepted" });
      }
    }

    if (authStatus !== "Accepted") {
      return;
    }

    if (this.outboundDelayMs > 0) {
      await delay(this.outboundDelayMs);
    }

    const meterStart = this.meterWh;
    const timestamp = new Date().toISOString();
    const startKey = `${connectorId}:${idTag}:${meterStart}`;

    if (this.lastStartTxKey === startKey && this.lastStartTxResponse) {
      this.transactionId = this.lastStartTxResponse.transactionId;
      this.idTag = idTag;
      this.connectorStatus = "Charging";
      return;
    }

    const started = await this.connection.call<{ transactionId?: number }>(Ocpp16Action.StartTransaction, {
      connectorId,
      idTag,
      meterStart,
      timestamp,
    });
    if (typeof started.transactionId !== "number") {
      throw new Error("StartTransaction.conf did not include transactionId");
    }

    this.lastStartTxKey = startKey;
    this.lastStartTxResponse = { transactionId: started.transactionId };

    this.transactionId = started.transactionId;
    this.idTag = idTag;
    this.connectorStatus = "Charging";
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Charging"));
    await this.connection.call(Ocpp16Action.MeterValues, {
      connectorId,
      transactionId: this.transactionId,
      meterValue: [this.sample()],
    });
  }

  private remoteStop(call: InboundCall): Record<string, unknown> {
    const transactionId = readNumber(call.payload, "transactionId");
    if (this.transactionId === null || transactionId !== this.transactionId) {
      return { status: "Rejected" };
    }
    setTimeout(() => {
      void this.finishTransaction().catch((error: unknown) => {
        console.error("Remote stop failed", error);
      });
    }, 0);
    return { status: "Accepted" };
  }

  private async finishTransaction(reason = "Remote"): Promise<void> {
    const transactionId = this.transactionId;
    if (transactionId === null) {
      return;
    }

    if (this.lastStopTxId === transactionId && this.lastStopTxResponse) {
      this.transactionId = null;
      this.idTag = null;
      this.connectorStatus = "Available";
      return;
    }

    this.connectorStatus = "Finishing";
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Finishing"));

    this.meterWh += 250;
    const meterStop = this.meterWh;
    const timestamp = new Date().toISOString();

    const response = await this.connection.call<Record<string, unknown>>(Ocpp16Action.StopTransaction, {
      transactionId,
      meterStop,
      timestamp,
      reason,
    });

    this.lastStopTxId = transactionId;
    this.lastStopTxResponse = response;

    this.transactionId = null;
    this.idTag = null;
    if (this.availabilityScheduled) {
      this.availabilityScheduled = false;
      this.connectorStatus = "Unavailable";
      await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Unavailable"));
      return;
    }
    this.connectorStatus = "Available";
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Available"));
  }

  async uploadOfflineTransactions(): Promise<number> {
    const queue = [...this.offlineQueue];
    let uploaded = 0;
    for (const tx of queue) {
      try {
        const started = await this.connection.call<{ transactionId?: number }>(Ocpp16Action.StartTransaction, {
          connectorId: tx.connectorId,
          idTag: tx.idTag,
          meterStart: tx.meterStart,
          timestamp: tx.startTimestamp,
        });
        if (typeof started.transactionId !== "number") {
          break;
        }
        await this.connection.call(Ocpp16Action.StopTransaction, {
          transactionId: started.transactionId,
          meterStop: tx.meterStop,
          timestamp: tx.stopTimestamp,
          reason: tx.reason,
        });
        uploaded += 1;
        this.offlineQueue = this.offlineQueue.filter((t) => t.localId !== tx.localId);
      } catch {
        break;
      }
    }
    return uploaded;
  }

  queueOfflineTransaction(tx: OfflineTransaction): void {
    this.offlineQueue.push(tx);
  }

  private reset(call: InboundCall): Record<string, unknown> {
    const type = readString(call.payload, "type");
    if (type !== "Soft" && type !== "Hard") {
      return { status: "Rejected" };
    }
    setTimeout(() => {
      this.close();
      this.connection.close();
    }, 25);
    return { status: "Accepted" };
  }


  private changeAvailability(call: InboundCall): Record<string, unknown> {
    const type = readString(call.payload, "type");
    const connectorId = readNumber(call.payload, "connectorId");
    if (type !== "Operative" && type !== "Inoperative") {
      return { status: "Rejected" };
    }
    if (connectorId !== undefined && connectorId !== 0 && connectorId !== this.connectorId) {
      return { status: "Rejected" };
    }

    if (type === "Inoperative") {
      if (this.transactionId !== null) {
        this.availabilityScheduled = true;
        return { status: "Scheduled" };
      }
      this.availabilityScheduled = false;
      this.connectorStatus = "Unavailable";
      setTimeout(() => {
        void this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Unavailable")).catch(() => undefined);
      }, 0);
      return { status: "Accepted" };
    }

    this.availabilityScheduled = false;
    if (this.connectorStatus === "Unavailable" || this.connectorStatus === "Faulted") {
      this.connectorStatus = "Available";
      setTimeout(() => {
        void this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Available")).catch(() => undefined);
      }, 0);
    }
    return { status: "Accepted" };
  }

  private reserveNow(call: InboundCall): Record<string, unknown> {
    const reservationId = readNumber(call.payload, "reservationId");
    const idTag = readString(call.payload, "idTag");
    const expiryDate = readString(call.payload, "expiryDate");
    const connectorId = readNumber(call.payload, "connectorId");

    if (reservationId === undefined || !idTag || !expiryDate) {
      return { status: "Rejected" };
    }
    if (connectorId !== undefined && connectorId !== 0 && connectorId !== this.connectorId) {
      return { status: "Rejected" };
    }
    if (this.transactionId !== null || this.connectorStatus === "Charging" || this.connectorStatus === "Preparing") {
      return { status: "Occupied" };
    }
    if (this.connectorStatus === "Unavailable" || this.connectorStatus === "Faulted") {
      return { status: "Unavailable" };
    }
    if (this.reservationId !== null && this.reservationId !== reservationId) {
      return { status: "Occupied" };
    }

    this.reservationId = reservationId;
    this.connectorStatus = "Reserved";
    setTimeout(() => {
      void this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Reserved")).catch(() => undefined);
    }, 0);
    return { status: "Accepted" };
  }

  private cancelReservation(call: InboundCall): Record<string, unknown> {
    const reservationId = readNumber(call.payload, "reservationId");
    if (reservationId === undefined || this.reservationId === null || reservationId !== this.reservationId) {
      return { status: "Rejected" };
    }
    this.reservationId = null;
    if (this.connectorStatus === "Reserved") {
      this.connectorStatus = "Available";
      setTimeout(() => {
        void this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Available")).catch(() => undefined);
      }, 0);
    }
    return { status: "Accepted" };
  }

  private setChargingProfile(call: InboundCall): Record<string, unknown> {
    const connectorId = readNumber(call.payload, "connectorId");
    const profile = call.payload["csChargingProfiles"];
    if (!profile || typeof profile !== "object") {
      return { status: "Rejected" };
    }
    if (connectorId !== undefined && connectorId !== 0 && connectorId !== this.connectorId) {
      return { status: "Rejected" };
    }
    const stackLevel = readNumber(profile as Record<string, unknown>, "stackLevel") ?? 0;
    const purpose = readString(profile as Record<string, unknown>, "chargingProfilePurpose") ?? "TxDefaultProfile";
    const key = `${purpose}:${stackLevel}`;
    this.chargingProfiles.set(key, profile as Record<string, unknown>);
    return { status: "Accepted" };
  }

  private clearChargingProfile(call: InboundCall): Record<string, unknown> {
    const id = readNumber(call.payload, "id");
    const purpose = readString(call.payload, "chargingProfilePurpose");
    const stackLevel = readNumber(call.payload, "stackLevel");

    if (id === undefined && !purpose && stackLevel === undefined) {
      this.chargingProfiles.clear();
      return { status: "Accepted" };
    }

    let cleared = false;
    for (const [key, profile] of [...this.chargingProfiles.entries()]) {
      const matchId = id === undefined || readNumber(profile, "chargingProfileId") === id;
      const matchPurpose = !purpose || readString(profile, "chargingProfilePurpose") === purpose;
      const matchStack = stackLevel === undefined || readNumber(profile, "stackLevel") === stackLevel;
      if (matchId && matchPurpose && matchStack) {
        this.chargingProfiles.delete(key);
        cleared = true;
      }
    }
    return { status: cleared || this.chargingProfiles.size === 0 ? "Accepted" : "Unknown" };
  }

  private getCompositeSchedule(call: InboundCall): Record<string, unknown> {
    const connectorId = readNumber(call.payload, "connectorId") ?? this.connectorId;
    const duration = readNumber(call.payload, "duration") ?? 3600;
    const profiles = [...this.chargingProfiles.values()];
    const schedulePeriod =
      profiles.length > 0
        ? [{ startPeriod: 0, limit: 16, numberPhases: 3 }]
        : [{ startPeriod: 0, limit: 32, numberPhases: 3 }];
    return {
      status: "Accepted",
      connectorId,
      scheduleStart: new Date().toISOString(),
      chargingSchedule: {
        duration,
        chargingRateUnit: "A",
        chargingSchedulePeriod: schedulePeriod,
      },
    };
  }

  private updateFirmware(call: InboundCall): Record<string, unknown> {
    const location = readString(call.payload, "location");
    if (!location) {
      return { status: "Rejected" };
    }
    const statuses = ["Downloading", "Downloaded", "Installing", "Installed"] as const;
    setTimeout(() => {
      void (async () => {
        for (const status of statuses) {
          try {
            await this.connection.call(Ocpp16Action.FirmwareStatusNotification, { status });
          } catch (error) {
            console.error("FirmwareStatusNotification failed", error);
            return;
          }
        }
      })();
    }, 0);
    return {};
  }

  private getDiagnostics(call: InboundCall): Record<string, unknown> {
    const location = readString(call.payload, "location");
    if (!location) {
      return {};
    }
    const fileName = `diag-${this.options.identity}-${Date.now()}.log`;
    setTimeout(() => {
      void (async () => {
        for (const status of ["Uploading", "Uploaded"] as const) {
          try {
            await this.connection.call(Ocpp16Action.DiagnosticsStatusNotification, { status });
          } catch (error) {
            console.error("DiagnosticsStatusNotification failed", error);
            return;
          }
        }
      })();
    }, 0);
    return { fileName };
  }

  private handleSendLocalList(call: InboundCall): Record<string, unknown> {
    const updateType = readString(call.payload, "updateType");
    const listVersion = readNumber(call.payload, "listVersion");
    const localAuthorizationList = call.payload["localAuthorizationList"];

    if (!updateType || listVersion === undefined) {
      return { status: "Failed" };
    }

    if (updateType === "Full") {
      this.localAuthList = [];
      this.authorizationCache.clear();
    }

    if (Array.isArray(localAuthorizationList)) {
      for (const entry of localAuthorizationList) {
        if (typeof entry === "object" && entry !== null) {
          const idTag = readString(entry, "idTag");
          const idTagInfo = entry["idTagInfo"] as { status?: string; expiryDate?: string } | undefined;
          if (idTag && idTagInfo?.status) {
            const authEntry: LocalAuthEntry = {
              idTag,
              status: idTagInfo.status as LocalAuthEntry["status"],
              ...(idTagInfo.expiryDate ? { expiryDate: idTagInfo.expiryDate } : {}),
            };
            if (updateType === "Differential") {
              this.localAuthList = this.localAuthList.filter((e) => e.idTag !== idTag);
            }
            this.localAuthList.push(authEntry);
            this.authorizationCache.set(idTag, authEntry);
          }
        }
      }
    }

    this.localAuthListVersion = listVersion;
    return { status: "Accepted" };
  }

  private changeConfiguration(call: InboundCall): Record<string, unknown> {
    const key = readString(call.payload, "key");
    const value = readString(call.payload, "value");
    if (!key || value === undefined) {
      return { status: "Rejected" };
    }
    if (key === "HeartbeatInterval") {
      const interval = Number(value);
      if (!Number.isInteger(interval) || interval < 0) {
        return { status: "Rejected" };
      }
      this.heartbeatInterval = interval;
      this.scheduleHeartbeat();
      return { status: "Accepted" };
    }
    const known = this.configuration().find((entry) => entry.key === key);
    if (!known) {
      return { status: "NotSupported" };
    }
    if (known.readonly) {
      return { status: "Rejected" };
    }
    return { status: "Accepted" };
  }

  private filterConfiguration(key: unknown): ConfigurationKey[] {
    const all = this.configuration();
    if (!Array.isArray(key) || key.length === 0) {
      return all;
    }
    const wanted = new Set(key.filter((entry): entry is string => typeof entry === "string"));
    return all.filter((entry) => wanted.has(entry.key));
  }

  private configuration(): ConfigurationKey[] {
    return [
      { key: "HeartbeatInterval", readonly: false, value: String(this.heartbeatInterval) },
      { key: "MeterValueSampleInterval", readonly: false, value: "10" },
      { key: "NumberOfConnectors", readonly: true, value: "1" },
      { key: "AuthorizeRemoteTxRequests", readonly: false, value: "true" },
    ];
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatInterval === 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.connection.call(Ocpp16Action.Heartbeat, {}).catch(() => undefined);
    }, this.heartbeatInterval * 1000);
  }

  private statusPayload(status: string): Record<string, unknown> {
    return {
      connectorId: this.connectorId,
      errorCode: "NoError",
      status,
      timestamp: new Date().toISOString(),
    };
  }

  private sample(): Record<string, unknown> {
    return {
      timestamp: new Date().toISOString(),
      sampledValue: [
        {
          value: String(this.meterWh),
          measurand: "Energy.Active.Import.Register",
          unit: "Wh",
        },
      ],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

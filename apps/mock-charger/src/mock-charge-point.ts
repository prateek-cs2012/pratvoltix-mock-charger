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

export interface MockChargePointOptions {
  identity: string;
  vendor?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  connectorId?: number;
}

interface ConfigurationKey {
  key: string;
  readonly: boolean;
  value: string;
}

export interface MockChargePointHooks {
  disconnectOcpp?: () => void;
}

export class MockChargePoint {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private meterWh = 1_000;
  private transactionId: number | null = null;
  private heartbeatInterval = 60;
  private readonly connectorId: number;

  constructor(
    private readonly connection: OcppConnection,
    private readonly options: MockChargePointOptions,
    private readonly faults?: FaultEngine,
    private readonly hooks: MockChargePointHooks = {},
  ) {
    this.connectorId = options.connectorId ?? 1;
    this.connection.onCall((call) => this.handleCall(call));
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

    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload(this.transactionId ? "Charging" : "Available"));
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
        return { status: "Accepted" };
      case Ocpp16Action.DataTransfer:
        return { status: "Rejected" };
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
        this.statusPayload(this.transactionId ? "Charging" : "Available"),
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
    const authorize = await this.connection.call<{ idTagInfo?: { status?: string } }>(Ocpp16Action.Authorize, { idTag });
    if (authorize.idTagInfo?.status !== "Accepted") {
      return;
    }

    const started = await this.connection.call<{ transactionId?: number }>(Ocpp16Action.StartTransaction, {
      connectorId,
      idTag,
      meterStart: this.meterWh,
      timestamp: new Date().toISOString(),
    });
    if (typeof started.transactionId !== "number") {
      throw new Error("StartTransaction.conf did not include transactionId");
    }
    this.transactionId = started.transactionId;
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

  private async finishTransaction(): Promise<void> {
    const transactionId = this.transactionId;
    this.meterWh += 250;
    await this.connection.call(Ocpp16Action.StopTransaction, {
      transactionId,
      meterStop: this.meterWh,
      timestamp: new Date().toISOString(),
      reason: "Remote",
    });
    this.transactionId = null;
    await this.connection.call(Ocpp16Action.StatusNotification, this.statusPayload("Available"));
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

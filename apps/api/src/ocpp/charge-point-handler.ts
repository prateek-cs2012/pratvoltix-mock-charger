import { Ocpp16Action, readString, type InboundCall, type OcppMessage } from "@pratvoltix/ocpp";
import { config } from "../config.js";
import { ChargePointModel } from "../models/charge-point.js";
import type { ChargePointSession } from "./registry.js";

export async function recordInbound(identity: string, message: OcppMessage): Promise<void> {
  if (message[0] !== 2) {
    await ChargePointModel.updateOne({ identity }, { lastSeenAt: new Date() });
    return;
  }

  const action = message[2];
  const payload = message[3];
  const update: Record<string, unknown> = {
    identity,
    lastSeenAt: new Date(),
    status: "connected",
    ocppVersion: "1.6",
  };

  if (action === Ocpp16Action.BootNotification) {
    assignString(update, "vendor", readString(payload, "chargePointVendor"));
    assignString(update, "model", readString(payload, "chargePointModel"));
    assignString(update, "serialNumber", readString(payload, "chargePointSerialNumber"));
    assignString(update, "firmwareVersion", readString(payload, "firmwareVersion"));
    update.lastBootAt = new Date();
  }

  if (action === Ocpp16Action.StatusNotification) {
    assignString(update, "connectorStatus", readString(payload, "status"));
  }

  await ChargePointModel.updateOne({ identity }, update, { upsert: true });
}

export async function handleChargePointCall(
  session: ChargePointSession,
  call: InboundCall,
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();

  switch (call.action) {
    case Ocpp16Action.BootNotification:
      return { status: "Accepted", currentTime: now, interval: config.heartbeatInterval };
    case Ocpp16Action.Heartbeat:
      return { currentTime: now };
    case Ocpp16Action.StatusNotification:
    case Ocpp16Action.MeterValues:
      return {};
    case Ocpp16Action.Authorize:
      return { idTagInfo: { status: "Accepted" } };
    case Ocpp16Action.StartTransaction: {
      session.transactionCounter += 1;
      const transactionId = session.transactionCounter;
      await ChargePointModel.updateOne({ identity: session.identity }, { activeTransactionId: transactionId });
      return { transactionId, idTagInfo: { status: "Accepted" } };
    }
    case Ocpp16Action.StopTransaction:
      await ChargePointModel.updateOne({ identity: session.identity }, { $unset: { activeTransactionId: 1 } });
      return { idTagInfo: { status: "Accepted" } };
    case Ocpp16Action.DataTransfer:
      return { status: "Rejected" };
    default:
      return {};
  }
}

function assignString(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

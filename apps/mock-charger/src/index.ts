import { CONTROL_PATH } from "@pratvoltix/simulator-control";
import { SimulatorControlClient } from "./control-client.js";
import { FaultEngine } from "./fault-engine.js";
import { OcppSession } from "./ocpp-session.js";

const identity = process.env.CHARGE_POINT_ID ?? "CP001";
const baseUrl = process.env.CSMS_URL ?? "ws://localhost:8080/ocpp";
const bootstrapUrl = `${baseUrl.replace(/\/$/, "")}/${identity}`;
const controlBase = process.env.CONTROL_URL ?? "ws://localhost:8080";
const controlUrl = controlBase.includes(CONTROL_PATH) ? controlBase : `${controlBase.replace(/\/$/, "")}${CONTROL_PATH}`;

const faults = new FaultEngine();
let notifyControl: (action: "ocpp-frame" | "ocpp-state", payload: unknown) => Promise<unknown> = async () => ({ accepted: false });
const session = new OcppSession({
  identity,
  bootstrapUrl,
  vendor: process.env.CHARGE_POINT_VENDOR,
  model: process.env.CHARGE_POINT_MODEL,
  faults,
  notify: (action, payload) => notifyControl(action, payload),
  log: (message) => console.log(message),
});
const control = new SimulatorControlClient({
  url: controlUrl,
  identity,
  simulatorName: process.env.SIMULATOR_NAME ?? "Pratvoltix Mock",
  simulatorVersion: process.env.SIMULATOR_VERSION ?? "0.1.0",
  faults,
  disconnectOcpp: () => {
    void session.disconnect(false);
  },
  connectOcpp: (url) => session.connect(url),
  disconnectTarget: (restoreBootstrap) => session.disconnect(restoreBootstrap),
  emitOcpp: (action, connectorId) => session.emit(action, connectorId),
  setReconnectStorm: (config) => session.setReconnectStorm(config),
  getReconnectStorm: () => session.getReconnectStorm(),
  setOutboundDelay: (delayMs) => session.setOutboundDelay(delayMs),
  getOutboundDelay: () => session.getOutboundDelay(),
  setLocalAuthList: (entries) => session.setLocalAuthList(entries),
  getLocalAuthList: () => session.getLocalAuthList(),
  uploadOfflineTransactions: () => session.uploadOfflineTransactions(),
  queueOfflineTransaction: (tx) => session.queueOfflineTransaction(tx),
  retryStartTransaction: (idTag, connectorId) => session.retryStartTransaction(idTag, connectorId),
  retryStopTransaction: () => session.retryStopTransaction(),
  restoreTransactionState: (state) => session.restoreTransactionState(state),
});
notifyControl = (action, payload) => control.notify(action, payload);

function shutdown(): void {
  control.stop();
  session.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

control.start();
session.start();

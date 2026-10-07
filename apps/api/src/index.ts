import { createServer } from "node:http";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { attachOcppServer } from "./ocpp/server.js";
import { SessionRegistry } from "./ocpp/registry.js";
import { attachSimulatorControl } from "./simulator/server.js";
import { SimulatorRegistry } from "./simulator/registry.js";

const registry = new SessionRegistry();
const simulators = new SimulatorRegistry();
const app = createApp(registry, simulators);
const server = createServer(app);
attachOcppServer(server, registry);
attachSimulatorControl(server, simulators);

async function shutdown(): Promise<void> {
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

// OCPP socket close rejects in-flight waitFor/call promises. Cases (and the live peer)
// handle that; this guard keeps a stray rejection from killing the lab API mid-run.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message === "OCPP connection closed" || (reason instanceof Error && reason.name === "OcppConnectionClosedError")) {
    console.warn(`[ocpp] ignored unhandled rejection: ${message}`);
    return;
  }
  console.error("[api] unhandledRejection", reason);
});

await mongoose.connect(config.mongodbUri);
server.listen(config.port, () => {
  console.log(`Pratvoltix API listening on ${config.port}`);
  console.log(`OCPP 1.6 endpoint ${config.publicWsUrl}/:chargePointId`);
  console.log("Simulator control endpoint /lab-control");
});

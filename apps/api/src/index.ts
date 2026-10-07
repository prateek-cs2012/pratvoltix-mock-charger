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

await mongoose.connect(config.mongodbUri);
server.listen(config.port, () => {
  console.log(`Pratvoltix API listening on ${config.port}`);
  console.log(`OCPP 1.6 endpoint ${config.publicWsUrl}/:chargePointId`);
  console.log("Simulator control endpoint /lab-control");
});

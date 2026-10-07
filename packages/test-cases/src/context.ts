import type { SimulatorController, ReconnectStormController, ExtendedSimulatorController } from "@pratvoltix/simulator-control";
import type { OcppPeer } from "@pratvoltix/ocpp";
import type { TestContext } from "@pratvoltix/test-runner";
import type { EffectiveOcppRunProfile } from "./profile.js";

export interface OcppTestContext extends TestContext {
  peer: OcppPeer;
  chargePointId: string;
  profile: EffectiveOcppRunProfile;
  simulator?: SimulatorController;
  reconnectStormController?: ReconnectStormController;
  extendedSimulator?: ExtendedSimulatorController;
}

export function requireSimulator(ctx: OcppTestContext): SimulatorController {
  if (!ctx.simulator) {
    throw new Error("Simulator controller is missing. Capability simulator-control was not established for this run.");
  }
  return ctx.simulator;
}

export function requireReconnectStormController(ctx: OcppTestContext): ReconnectStormController {
  if (!ctx.reconnectStormController) {
    throw new Error("Reconnect storm controller is missing. Capability reconnect-storm was not established for this run.");
  }
  return ctx.reconnectStormController;
}

export function requireExtendedSimulator(ctx: OcppTestContext): ExtendedSimulatorController {
  if (!ctx.extendedSimulator) {
    throw new Error("Extended simulator controller is missing. Capability simulator-control was not established for this run.");
  }
  return ctx.extendedSimulator;
}

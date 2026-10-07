import type { SimulatorController } from "@pratvoltix/simulator-control";
import type { OcppPeer } from "@pratvoltix/ocpp";
import type { TestContext } from "@pratvoltix/test-runner";
import type { EffectiveOcppRunProfile } from "./profile.js";

export interface OcppTestContext extends TestContext {
  peer: OcppPeer;
  chargePointId: string;
  profile: EffectiveOcppRunProfile;
  simulator?: SimulatorController;
}

export function requireSimulator(ctx: OcppTestContext): SimulatorController {
  if (!ctx.simulator) {
    throw new Error("Simulator controller is missing. Capability simulator-control was not established for this run.");
  }
  return ctx.simulator;
}

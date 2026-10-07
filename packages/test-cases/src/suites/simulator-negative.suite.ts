import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defineSuite } from "../definitions.js";

export const simulatorNegativeSuite = defineSuite({
  id: "simulator-negative",
  title: "Simulator negative",
  description: "Negative OCPP responses that require the mock charger's control channel.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  scenarioIds: ["negative-responses"],
});

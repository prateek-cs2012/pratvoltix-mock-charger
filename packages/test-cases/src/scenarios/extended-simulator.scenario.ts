import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defineScenario } from "../definitions.js";

export const extendedSimulatorScenario = defineScenario({
  id: "extended-simulator",
  title: "Extended simulator control",
  description: "Tests for gaps 2/3/4: outbound delay injection, local authorization list, and offline transaction upload.",
  version: "1.6",
  tags: ["simulator", "extended"],
  requirements: [SIMULATOR_CAPABILITY],
  caseIds: ["outbound-delay", "local-auth-skip", "offline-upload"],
});

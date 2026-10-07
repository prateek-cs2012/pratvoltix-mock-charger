import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defineScenario } from "../definitions.js";

export const negativeResponsesScenario = defineScenario({
  id: "negative-responses",
  title: "Negative responses",
  description: "One-shot simulator faults for rejected, failed, timed-out, and delayed calls.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  caseIds: ["remote-start-rejected", "reset-call-error", "get-configuration-timeout", "delayed-trigger-heartbeat"],
});

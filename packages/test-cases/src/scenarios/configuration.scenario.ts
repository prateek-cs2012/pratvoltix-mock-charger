import { defineScenario } from "../definitions.js";

export const configurationScenario = defineScenario({
  id: "configuration",
  title: "Configuration",
  description: "Read configuration, change HeartbeatInterval, and restore it.",
  version: "1.6",
  tags: ["configuration"],
  caseIds: ["get-configuration", "change-configuration"],
});

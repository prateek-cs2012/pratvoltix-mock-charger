import { defineScenario } from "../definitions.js";

export const smokeScenario = defineScenario({
  id: "smoke",
  title: "Boot and register",
  description: "Boot the charge point, then check heartbeat and connector status.",
  version: "1.6",
  tags: ["smoke", "core"],
  caseIds: ["boot-notification", "heartbeat", "status-notification"],
});

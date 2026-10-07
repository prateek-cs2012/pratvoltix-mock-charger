import { defineSuite } from "../definitions.js";

export const smokeSuite = defineSuite({
  id: "smoke",
  title: "Smoke",
  description: "Boot, heartbeat, and status notification.",
  version: "1.6",
  tags: ["smoke"],
  scenarioIds: ["smoke"],
});

import { defineScenario } from "../definitions.js";

export const csmsActionsScenario = defineScenario({
  id: "csms-actions",
  title: "CSMS→CP action stubs (Gap 9)",
  description: "Minimal Accepted/Rejected implementations for ChangeAvailability, Reserve*, ChargingProfile*, UpdateFirmware, and GetDiagnostics.",
  version: "1.6",
  tags: ["csms-action", "gap-9"],
  caseIds: ["change-availability", "reserve-now", "charging-profile", "firmware-diagnostics"],
});

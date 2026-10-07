import { defineSuite } from "../definitions.js";

export const fullOcpp16Suite = defineSuite({
  id: "full-ocpp16",
  title: "Full OCPP 1.6 regression",
  description: "Physical-charger OCPP 1.6 regression. Soft reset stays last because it drops the connection.",
  version: "1.6",
  tags: ["regression"],
  caseIds: [
    "boot-notification",
    "heartbeat",
    "status-notification",
    "get-configuration",
    "change-configuration",
    "transaction-lifecycle",
    "soft-reset",
  ],
});

import { defineScenario } from "../definitions.js";

export const transactionScenario = defineScenario({
  id: "transaction",
  title: "Transaction lifecycle",
  description: "Run one remote start and remote stop transaction.",
  version: "1.6",
  tags: ["transaction"],
  caseIds: ["transaction-lifecycle"],
});

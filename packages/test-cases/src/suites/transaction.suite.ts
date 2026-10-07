import { defineSuite } from "../definitions.js";

export const transactionSuite = defineSuite({
  id: "transaction",
  title: "Transaction regression",
  description: "Remote transaction workflow.",
  version: "1.6",
  tags: ["transaction"],
  scenarioIds: ["transaction"],
});

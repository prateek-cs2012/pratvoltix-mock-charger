import { configurationScenario } from "./configuration.scenario.js";
import { negativeResponsesScenario } from "./negative-responses.scenario.js";
import { smokeScenario } from "./smoke.scenario.js";
import { transactionScenario } from "./transaction.scenario.js";

export const scenarios = [smokeScenario, configurationScenario, transactionScenario, negativeResponsesScenario];

import { configurationSuite } from "./configuration.suite.js";
import { fullOcpp16Suite } from "./full-ocpp16.suite.js";
import { simulatorNegativeSuite } from "./simulator-negative.suite.js";
import { smokeSuite } from "./smoke.suite.js";
import { transactionSuite } from "./transaction.suite.js";

export const suites = [smokeSuite, configurationSuite, transactionSuite, fullOcpp16Suite, simulatorNegativeSuite];

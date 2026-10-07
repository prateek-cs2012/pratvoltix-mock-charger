import { bootNotificationCase } from "./boot-notification.case.js";
import { changeConfigurationCase } from "./change-configuration.case.js";
import { getConfigurationCase } from "./get-configuration.case.js";
import { delayedTriggerHeartbeatCase } from "./delayed-trigger-heartbeat.case.js";
import { getConfigurationTimeoutCase } from "./get-configuration-timeout.case.js";
import { heartbeatCase } from "./heartbeat.case.js";
import { remoteStartRejectedCase } from "./remote-start-rejected.case.js";
import { resetCallErrorCase } from "./reset-call-error.case.js";
import { softResetCase } from "./soft-reset.case.js";
import { statusNotificationCase } from "./status-notification.case.js";
import { transactionLifecycleCase } from "./transaction-lifecycle.case.js";

/** Registration order is the sequence used for tag selection. List soft reset last in suites that run it. */
export const cases = [
  bootNotificationCase,
  heartbeatCase,
  statusNotificationCase,
  getConfigurationCase,
  changeConfigurationCase,
  transactionLifecycleCase,
  softResetCase,
  remoteStartRejectedCase,
  resetCallErrorCase,
  getConfigurationTimeoutCase,
  delayedTriggerHeartbeatCase,
];

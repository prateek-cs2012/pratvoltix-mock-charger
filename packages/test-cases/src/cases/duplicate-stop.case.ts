import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const duplicateStopCase = defineTestCase<OcppTestContext>({
  id: "duplicate-stop",
  title: "Duplicate StopTransaction is idempotent",
  description:
    "Completes a stop, restores the same transactionId via restore-transaction-state, then retries stop. Only one StopTransaction must reach the CSMS.",
  version: "1.6",
  tags: ["simulator", "idempotency"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { connectorId, idTag, transactionId, eventTimeoutMs } = ctx.profile.parameters;

    let stopCount = 0;

    const authorize = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs).then((c) => {
      c.reply({ idTagInfo: { status: "Accepted" } });
    });
    const startTx = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs).then((c) => {
      c.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    });
    const charging = ctx.peer
      .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => p["status"] === "Charging")
      .then((c) => c.reply({}));

    ctx.log("Starting transaction via retry-start-transaction");
    await Promise.all([extended.retryStartTransaction(idTag, connectorId), authorize, startTx, charging]);

    const firstStop = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs).then((c) => {
      stopCount += 1;
      c.reply({ idTagInfo: { status: "Accepted" } });
    });
    const available = ctx.peer
      .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => p["status"] === "Available")
      .then((c) => c.reply({}));

    ctx.log("First retry-stop-transaction");
    await Promise.all([extended.retryStopTransaction(), firstStop, available]);
    assertEqual(stopCount, 1, "First stop should send StopTransaction once");

    ctx.log("Restoring transaction state and retrying stop");
    await extended.restoreTransactionState({
      transactionId,
      idTag,
      connectorStatus: "Charging",
    });

    const lateStop = ctx.peer
      .waitFor(Ocpp16Action.StopTransaction, 800)
      .then(() => {
        stopCount += 1;
        throw new Error("Unexpected second StopTransaction");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "Unexpected second StopTransaction") {
          throw error;
        }
      });

    await extended.retryStopTransaction();
    await lateStop;
    assertEqual(stopCount, 1, "Duplicate stop must not call CSMS StopTransaction again");
    ctx.log("Duplicate StopTransaction suppressed as expected");
  },
});

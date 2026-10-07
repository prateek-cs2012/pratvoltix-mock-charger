import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const duplicateStartCase = defineTestCase<OcppTestContext>({
  id: "duplicate-start",
  title: "Duplicate StartTransaction is idempotent",
  description:
    "Starts a transaction via retry-start-transaction, then retries with the same idTag/meter key. Only one StartTransaction must reach the CSMS; the second uses the cached transactionId.",
  version: "1.6",
  tags: ["simulator", "idempotency"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { connectorId, idTag, transactionId, eventTimeoutMs } = ctx.profile.parameters;

    let startCount = 0;
    const firstStart = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs).then(async (call) => {
      startCount += 1;
      call.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    });
    const authorize = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs).then((call) => {
      call.reply({ idTagInfo: { status: "Accepted" } });
    });

    ctx.log("First retry-start-transaction");
    await Promise.all([
      extended.retryStartTransaction(idTag, connectorId),
      authorize,
      firstStart,
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => p["status"] === "Charging")
        .then((c) => c.reply({})),
    ]);
    assertEqual(startCount, 1, "First start should send StartTransaction once");

    ctx.log("Second retry-start-transaction (same key) — must not send another StartTransaction");
    const lateStart = ctx.peer
      .waitFor(Ocpp16Action.StartTransaction, 800)
      .then(() => {
        startCount += 1;
        throw new Error("Unexpected second StartTransaction");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "Unexpected second StartTransaction") {
          throw error;
        }
        // timeout = good
      });

    await extended.retryStartTransaction(idTag, connectorId);
    await lateStart;
    assertEqual(startCount, 1, "Duplicate start must not call CSMS StartTransaction again");
    ctx.log("Duplicate StartTransaction suppressed as expected");
  },
});

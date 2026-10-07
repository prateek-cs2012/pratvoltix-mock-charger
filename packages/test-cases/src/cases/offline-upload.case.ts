import { Ocpp16Action, readNumber } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const offlineUploadCase = defineTestCase<OcppTestContext>({
  id: "offline-upload",
  title: "Offline transaction upload uses CSMS-assigned transactionId",
  description: "Queues an offline transaction with a local ID, then uploads it. The StopTransaction must use the transactionId returned by the CSMS in StartTransaction.conf, not a locally assigned ID.",
  version: "1.6",
  tags: ["simulator", "offline"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { eventTimeoutMs } = ctx.profile.parameters;
    const csmsTransactionId = 77777;

    ctx.log("Queueing offline transaction with localId=999");
    await extended.queueOfflineTransaction({
      localId: 999,
      connectorId: 1,
      idTag: "OFFLINE-TAG",
      meterStart: 10000,
      meterStop: 10500,
      startTimestamp: "2024-01-15T10:00:00Z",
      stopTimestamp: "2024-01-15T10:30:00Z",
      reason: "Local",
    });

    const startTxPromise = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);
    const stopTxPromise = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);

    ctx.log("Triggering offline transaction upload");
    const uploadPromise = extended.uploadOfflineTransactions();

    const startTx = await startTxPromise;
    ctx.log(`Received StartTransaction: idTag=${startTx.payload["idTag"]}`);
    startTx.reply({ transactionId: csmsTransactionId, idTagInfo: { status: "Accepted" } });

    const stopTx = await stopTxPromise;
    const stopTxId = readNumber(stopTx.payload, "transactionId");
    ctx.log(`Received StopTransaction: transactionId=${stopTxId}`);

    assertEqual(stopTxId, csmsTransactionId, "StopTransaction must use CSMS-assigned transactionId, not localId");
    stopTx.reply({ idTagInfo: { status: "Accepted" } });

    const uploaded = await uploadPromise;
    assertEqual(uploaded, 1, "One transaction should have been uploaded");

    ctx.log("Offline upload completed successfully with CSMS-assigned transactionId");
  },
});

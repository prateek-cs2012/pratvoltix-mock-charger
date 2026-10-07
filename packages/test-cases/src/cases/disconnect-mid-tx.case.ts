import { Ocpp16Action, readNumber, readString } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, assertDefined, assertEqual, waitFor } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireSimulator } from "../context.js";
import { withFault } from "../with-fault.js";

export const disconnectMidTxCase = defineTestCase<OcppTestContext>({
  id: "disconnect-mid-tx",
  title: "Disconnect mid-transaction recovery",
  description: "Starts a transaction, disconnects the charge point mid-transaction via fault injection, then verifies that after reconnect the charge point restores the correct connector status (Charging), retains the transaction ID, and can complete the transaction with StopTransaction correlating to the pre-disconnect transaction.",
  version: "1.6",
  tags: ["transaction", "reconnect", "fault-injection"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 60_000,
  async run(ctx) {
    const simulator = requireSimulator(ctx);
    const { connectorId, idTag, transactionId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    const authorizePromise = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs);
    const startPromise = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);

    const remoteStart = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStartTransaction,
      { connectorId, idTag },
      callTimeoutMs,
    );
    assertEqual(remoteStart.status, "Accepted", "RemoteStartTransaction should be accepted");

    const authorize = await authorizePromise;
    authorize.reply({ idTagInfo: { status: "Accepted" } });
    ctx.log(`Authorized ${idTag}`);

    const started = await startPromise;
    const meterStart = readNumber(started.payload, "meterStart");
    assertDefined(meterStart, "meterStart is required");
    started.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    ctx.log(`Transaction ${transactionId} started at ${meterStart} Wh`);

    await ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (payload) => {
      return payload["status"] === "Charging";
    }).then((call) => call.reply({}));
    ctx.log("Charge point is now Charging");

    ctx.log("Injecting disconnect fault to simulate mid-tx socket drop");
    await withFault(
      simulator,
      {
        id: "mid-tx-disconnect",
        consume: "once",
        match: { action: Ocpp16Action.Heartbeat, occurrence: 1 },
        effect: { type: "disconnect" },
      },
      async () => {
        await ctx.peer.call(Ocpp16Action.TriggerMessage, { requestedMessage: Ocpp16Action.Heartbeat }, callTimeoutMs).catch(() => undefined);
        await waitFor(500);
      },
    );
    ctx.log("Disconnect fault triggered, waiting for reconnect...");

    const bootPromise = ctx.peer.waitFor(Ocpp16Action.BootNotification, eventTimeoutMs * 2);
    const boot = await bootPromise;
    boot.reply({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 });
    ctx.log("Charge point reconnected and sent BootNotification");

    const statusAfterReconnect = await ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs);
    const restoredStatus = readString(statusAfterReconnect.payload, "status");
    assertEqual(restoredStatus, "Charging", "Connector status after reconnect should be Charging (restored from persisted state)");
    statusAfterReconnect.reply({});
    ctx.log("Confirmed connector status restored to Charging after reconnect");

    const stopPromise = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);
    const availablePromise = ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (payload) => {
      return payload["status"] === "Available";
    });

    const remoteStop = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStopTransaction,
      { transactionId },
      callTimeoutMs,
    );
    assertEqual(remoteStop.status, "Accepted", "RemoteStopTransaction should be accepted");

    const stopped = await stopPromise;
    const stoppedTxId = readNumber(stopped.payload, "transactionId");
    assertEqual(stoppedTxId, transactionId, "StopTransaction should correlate to the pre-disconnect transaction ID");
    const meterStop = readNumber(stopped.payload, "meterStop");
    assertDefined(meterStop, "meterStop is required");
    assert(meterStop >= meterStart, "meterStop should not be lower than meterStart");
    stopped.reply({ idTagInfo: { status: "Accepted" } });
    ctx.log(`Transaction ${transactionId} stopped at ${meterStop} Wh (recovered after disconnect)`);

    const available = await availablePromise;
    available.reply({});
    ctx.log("Connector returned to Available");
  },
});

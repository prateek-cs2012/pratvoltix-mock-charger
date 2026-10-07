import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const localAuthSkipCase = defineTestCase<OcppTestContext>({
  id: "local-auth-skip",
  title: "Local authorization list skips Authorize",
  description: "Configures a local auth list entry, then issues RemoteStart with that idTag. The charger should skip the Authorize call to CSMS and proceed directly to StartTransaction.",
  version: "1.6",
  tags: ["simulator", "authorization"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { connectorId, idTag, transactionId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    ctx.log(`Setting local auth list with idTag=${idTag} status=Accepted`);
    await extended.setLocalAuthList([{ idTag, status: "Accepted" }]);

    let authorizeReceived = false;
    const authorizeListener = ctx.peer.waitFor(Ocpp16Action.Authorize, 500).then(() => {
      authorizeReceived = true;
    }).catch(() => {
      // Expected: no Authorize call
    });

    const chargingPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Charging",
    );

    const remoteStart = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStartTransaction,
      { connectorId, idTag },
      callTimeoutMs,
    );
    assertEqual(remoteStart.status, "Accepted", "RemoteStartTransaction should be accepted");

    const startTx = await ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);
    startTx.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    ctx.log("StartTransaction received (Authorize was skipped due to local auth)");

    await authorizeListener;
    assert(!authorizeReceived, "Authorize should NOT have been called because idTag is in local auth list");

    const charging = await chargingPromise;
    charging.reply({});

    const stopTx = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);
    const availablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Available",
    );
    await ctx.peer.call(Ocpp16Action.RemoteStopTransaction, { transactionId }, callTimeoutMs);
    const stopped = await stopTx;
    stopped.reply({ idTagInfo: { status: "Accepted" } });

    const available = await availablePromise;
    available.reply({});

    await extended.setLocalAuthList([]);
    ctx.log("Local auth list cleared");
  },
});

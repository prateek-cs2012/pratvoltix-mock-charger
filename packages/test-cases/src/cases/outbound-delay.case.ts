import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const outboundDelayCase = defineTestCase<OcppTestContext>({
  id: "outbound-delay",
  title: "Outbound delay injection",
  description: "Configures an outbound delay before Authorize/StartTransaction, then issues RemoteStart. RemoteStart.conf should return promptly while Authorize/StartTransaction are delayed.",
  version: "1.6",
  tags: ["simulator", "delay"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { connectorId, idTag, transactionId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    ctx.log("Setting outbound delay to 500ms");
    await extended.setOutboundDelay(500);

    const remoteStartTime = Date.now();
    const remoteStart = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStartTransaction,
      { connectorId, idTag },
      callTimeoutMs,
    );
    const remoteStartDuration = Date.now() - remoteStartTime;

    assertEqual(remoteStart.status, "Accepted", "RemoteStartTransaction should be accepted");
    assert(remoteStartDuration < 200, `RemoteStart.conf should return promptly (took ${remoteStartDuration}ms)`);
    ctx.log(`RemoteStart.conf returned in ${remoteStartDuration}ms`);

    const authorizeTime = Date.now();
    const authorize = await ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs);
    const authorizeDuration = Date.now() - authorizeTime;
    authorize.reply({ idTagInfo: { status: "Accepted" } });
    ctx.log(`Authorize received after ${authorizeDuration}ms delay`);

    const startTx = await ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);
    startTx.reply({ transactionId, idTagInfo: { status: "Accepted" } });

    await ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Charging").then((c) => c.reply({}));

    await extended.clearOutboundDelay();
    ctx.log("Outbound delay cleared");

    const stopTx = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);
    await ctx.peer.call(Ocpp16Action.RemoteStopTransaction, { transactionId }, callTimeoutMs);
    const stopped = await stopTx;
    stopped.reply({ idTagInfo: { status: "Accepted" } });

    await ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Available").then((c) => c.reply({}));
    ctx.log("Transaction completed successfully");
  },
});

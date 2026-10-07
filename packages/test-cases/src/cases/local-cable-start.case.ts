import { Ocpp16Action, readNumber, readString } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, assertDefined, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireExtendedSimulator } from "../context.js";

export const localCableStartCase = defineTestCase<OcppTestContext>({
  id: "local-cable-start",
  title: "Local cable start with Preparing/Finishing statuses",
  description:
    "Simulates a non-remote (cable) start: Preparing → Authorize → StartTransaction → Charging, optional SuspendedEVSE, then local stop with Finishing and StopTransaction.reason=Local.",
  version: "1.6",
  tags: ["transaction", "status", "simulator", "local-start"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 45_000,
  async run(ctx) {
    const extended = requireExtendedSimulator(ctx);
    const { connectorId, idTag, transactionId, eventTimeoutMs } = ctx.profile.parameters;

    let meterStart = 0;

    ctx.log("Triggering local cable start (control + peer replies in parallel)");
    await Promise.all([
      extended.localStart(idTag, connectorId),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Preparing")
        .then((c) => {
          c.reply({});
          ctx.log("Preparing observed");
        }),
      ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs).then((c) => {
        c.reply({ idTagInfo: { status: "Accepted" } });
      }),
      ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs).then((c) => {
        const ms = readNumber(c.payload, "meterStart");
        assertDefined(ms, "meterStart is required");
        meterStart = ms;
        c.reply({ transactionId, idTagInfo: { status: "Accepted" } });
      }),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Charging")
        .then((c) => {
          c.reply({});
          ctx.log("Charging after local start");
        }),
    ]);

    ctx.log("Injecting SuspendedEVSE mid-tx");
    await Promise.all([
      extended.setConnectorStatus("SuspendedEVSE"),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "SuspendedEVSE")
        .then((c) => c.reply({})),
    ]);

    await Promise.all([
      extended.setConnectorStatus("Charging"),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Charging")
        .then((c) => c.reply({})),
    ]);

    let stopReason: string | undefined;
    let meterStop = 0;

    ctx.log("Triggering local stop with reason=Local (control + peer replies in parallel)");
    await Promise.all([
      extended.localStop("Local"),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Finishing")
        .then((c) => c.reply({})),
      ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs).then((c) => {
        assertEqual(readNumber(c.payload, "transactionId"), transactionId, "Stop transactionId");
        stopReason = readString(c.payload, "reason");
        const ms = readNumber(c.payload, "meterStop");
        assertDefined(ms, "meterStop");
        meterStop = ms;
        c.reply({ idTagInfo: { status: "Accepted" } });
      }),
      ctx.peer
        .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Available")
        .then((c) => c.reply({})),
    ]);

    assertEqual(stopReason, "Local", "StopTransaction.reason should be Local");
    assert(meterStop >= meterStart, "meterStop >= meterStart");
    ctx.log("Local cable start/stop path complete");
  },
});

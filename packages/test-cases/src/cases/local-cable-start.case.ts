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

    const preparingPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Preparing",
    );
    const authorizePromise = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs);
    const startPromise = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);
    const chargingPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Charging",
    );

    ctx.log("Triggering local cable start");
    await extended.localStart(idTag, connectorId);

    const preparing = await preparingPromise;
    preparing.reply({});
    ctx.log("Preparing observed");

    const authorize = await authorizePromise;
    authorize.reply({ idTagInfo: { status: "Accepted" } });

    const started = await startPromise;
    const meterStart = readNumber(started.payload, "meterStart");
    assertDefined(meterStart, "meterStart is required");
    started.reply({ transactionId, idTagInfo: { status: "Accepted" } });

    const charging = await chargingPromise;
    charging.reply({});
    ctx.log("Charging after local start");

    const suspendedPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "SuspendedEVSE",
    );
    await extended.setConnectorStatus("SuspendedEVSE");
    const suspended = await suspendedPromise;
    suspended.reply({});
    ctx.log("SuspendedEVSE injected");

    await extended.setConnectorStatus("Charging");
    await ctx.peer
      .waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (p) => readString(p, "status") === "Charging")
      .then((c) => c.reply({}));

    const finishingPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Finishing",
    );
    const stopPromise = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);
    const availablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Available",
    );

    ctx.log("Triggering local stop with reason=Local");
    await extended.localStop("Local");

    const finishing = await finishingPromise;
    finishing.reply({});

    const stopped = await stopPromise;
    assertEqual(readNumber(stopped.payload, "transactionId"), transactionId, "Stop transactionId");
    assertEqual(readString(stopped.payload, "reason"), "Local", "StopTransaction.reason should be Local");
    const meterStop = readNumber(stopped.payload, "meterStop");
    assertDefined(meterStop, "meterStop");
    assert(meterStop >= meterStart, "meterStop >= meterStart");
    stopped.reply({ idTagInfo: { status: "Accepted" } });

    const available = await availablePromise;
    available.reply({});
    ctx.log("Local cable start/stop path complete");
  },
});

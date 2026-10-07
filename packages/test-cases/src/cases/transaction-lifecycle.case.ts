import { Ocpp16Action, readNumber, readString } from "@pratvoltix/ocpp";
import { assert, assertDefined, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const transactionLifecycleCase = defineTestCase<OcppTestContext>({
  id: "transaction-lifecycle",
  title: "Transaction lifecycle",
  description: "Remote start, authorize, start, meter, remote stop, and stop a transaction using the configured connector, ID tag, and transaction ID.",
  version: "1.6",
  tags: ["transaction"],
  timeoutMs: 30_000,
  async run(ctx) {
    const { connectorId, idTag, transactionId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;
    const authorizePromise = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs);
    const startPromise = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs);
    const meterPromise = ctx.peer.waitFor(Ocpp16Action.MeterValues, eventTimeoutMs);
    const chargingPromise = ctx.peer.waitFor(Ocpp16Action.StatusNotification, eventTimeoutMs, (payload) => {
      return payload["status"] === "Charging";
    });

    const remoteStart = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStartTransaction,
      { connectorId, idTag },
      callTimeoutMs,
    );
    assertEqual(remoteStart.status, "Accepted", "RemoteStartTransaction should be accepted");

    const authorize = await authorizePromise;
    assertEqual(readString(authorize.payload, "idTag"), idTag, "Authorize should use the configured id tag");
    authorize.reply({ idTagInfo: { status: "Accepted" } });
    ctx.log(`Authorized ${idTag}`);

    const started = await startPromise;
    assertEqual(readNumber(started.payload, "connectorId"), connectorId, "StartTransaction connectorId should match the profile");
    assertEqual(readString(started.payload, "idTag"), idTag);
    const meterStart = readNumber(started.payload, "meterStart");
    assertDefined(meterStart, "meterStart is required");
    started.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    ctx.log(`Transaction ${transactionId} started at ${meterStart} Wh`);

    const charging = await chargingPromise;
    charging.reply({});
    const meter = await meterPromise;
    assertEqual(readNumber(meter.payload, "transactionId"), transactionId, "MeterValues should carry the configured transaction id");
    const meterValue = meter.payload["meterValue"];
    assert(Array.isArray(meterValue) && meterValue.length > 0, "MeterValues should include a sample");
    meter.reply({});

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
    assertEqual(readNumber(stopped.payload, "transactionId"), transactionId);
    const meterStop = readNumber(stopped.payload, "meterStop");
    assertDefined(meterStop, "meterStop is required");
    assert(meterStop >= meterStart, "meterStop should not be lower than meterStart");
    stopped.reply({ idTagInfo: { status: "Accepted" } });
    ctx.log(`Transaction ${transactionId} stopped at ${meterStop} Wh`);

    const available = await availablePromise;
    available.reply({});
  },
});

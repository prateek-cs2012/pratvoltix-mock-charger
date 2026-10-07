import { Ocpp16Action, readNumber, readString } from "@pratvoltix/ocpp";
import { assert, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const configMeterRealismCase = defineTestCase<OcppTestContext>({
  id: "config-meter-realism",
  title: "Mutable config applies; periodic MeterValues while charging",
  description:
    "ChangeConfiguration for MeterValueSampleInterval actually takes effect (GetConfiguration reflects it) and emits periodic MeterValues during an active transaction.",
  version: "1.6",
  tags: ["configuration", "meter", "gap-10"],
  timeoutMs: 30_000,
  async run(ctx) {
    const { connectorId, idTag, transactionId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    const changed = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.ChangeConfiguration,
      { key: "MeterValueSampleInterval", value: "1" },
      callTimeoutMs,
    );
    assertEqual(changed.status, "Accepted", "MeterValueSampleInterval ChangeConfiguration");

    const got = await ctx.peer.call<{ configurationKey?: Array<{ key?: string; value?: string }> }>(
      Ocpp16Action.GetConfiguration,
      { key: ["MeterValueSampleInterval"] },
      callTimeoutMs,
    );
    const entry = (got.configurationKey ?? []).find((k) => k.key === "MeterValueSampleInterval");
    assertEqual(entry?.value, "1", "GetConfiguration should reflect applied MeterValueSampleInterval");

    const chargingPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Charging",
    );
    const authorizePromise = ctx.peer.waitFor(Ocpp16Action.Authorize, eventTimeoutMs).then((c) => {
      c.reply({ idTagInfo: { status: "Accepted" } });
    });
    const startPromise = ctx.peer.waitFor(Ocpp16Action.StartTransaction, eventTimeoutMs).then((c) => {
      c.reply({ transactionId, idTagInfo: { status: "Accepted" } });
    });

    const remote = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.RemoteStartTransaction,
      { connectorId, idTag },
      callTimeoutMs,
    );
    assertEqual(remote.status, "Accepted", "RemoteStartTransaction");
    await Promise.all([authorizePromise, startPromise, chargingPromise.then((c) => c.reply({}))]);

    // Initial MeterValues at start + at least one periodic sample (interval=1s)
    let periodicCount = 0;
    const deadline = Date.now() + Math.min(eventTimeoutMs, 8_000);
    while (Date.now() < deadline && periodicCount < 2) {
      const mv = await ctx.peer.waitFor(Ocpp16Action.MeterValues, Math.max(deadline - Date.now(), 1_000));
      const tid = readNumber(mv.payload, "transactionId");
      assertEqual(tid, transactionId, "MeterValues.transactionId");
      mv.reply({});
      periodicCount += 1;
    }
    assert(periodicCount >= 2, `Expected >=2 MeterValues while charging, got ${periodicCount}`);
    ctx.log(`Observed ${periodicCount} MeterValues with sample interval 1s`);

    const availablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Available",
    );
    const stopPromise = ctx.peer.waitFor(Ocpp16Action.StopTransaction, eventTimeoutMs);
    await ctx.peer.call(Ocpp16Action.RemoteStopTransaction, { transactionId }, callTimeoutMs);
    const stopped = await stopPromise;
    stopped.reply({ idTagInfo: { status: "Accepted" } });
    // Finishing may arrive before Available — drain with predicate
    const available = await availablePromise;
    available.reply({});

    // Restore defaults so later catalog cases are not polluted
    await ctx.peer.call(Ocpp16Action.ChangeConfiguration, { key: "MeterValueSampleInterval", value: "10" }, callTimeoutMs);
    await ctx.peer.call(Ocpp16Action.ClearCache, {}, callTimeoutMs);
    ctx.log("Config/meter realism path complete");
  },
});

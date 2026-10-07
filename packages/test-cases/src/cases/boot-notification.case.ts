import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { assertDefined, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const bootNotificationCase = defineTestCase<OcppTestContext>({
  id: "boot-notification",
  title: "BootNotification accepted",
  description: "Trigger a BootNotification and accept the charge point onto the network.",
  version: "1.6",
  tags: ["core", "trigger"],
  deployment: "external-compatible",
  timeoutMs: 15_000,
  async run(ctx) {
    const timeouts = ctx.profile.parameters;
    const incoming = ctx.peer.waitFor(Ocpp16Action.BootNotification, timeouts.eventTimeoutMs);
    const trigger = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.TriggerMessage,
      { requestedMessage: Ocpp16Action.BootNotification },
      timeouts.callTimeoutMs,
    );
    assertEqual(trigger.status, "Accepted", "TriggerMessage should be accepted");
    const boot = await incoming;
    const vendor = readString(boot.payload, "chargePointVendor");
    const model = readString(boot.payload, "chargePointModel");
    assertDefined(vendor, "chargePointVendor is required");
    assertDefined(model, "chargePointModel is required");
    ctx.log(`${vendor} ${model} booted`);
    boot.reply({
      status: "Accepted",
      currentTime: new Date().toISOString(),
      interval: 60,
    });
  },
});

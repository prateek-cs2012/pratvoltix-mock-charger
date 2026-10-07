import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, waitFor } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireReconnectStormController } from "../context.js";

export const reconnectStormCase = defineTestCase<OcppTestContext>({
  id: "reconnect-storm",
  title: "Reconnect storm CSMS resilience",
  description:
    "Configures the charge point simulator to perform burst reconnections with minimal delay, simulating a reconnect storm. Verifies that the CSMS can handle rapid successive connections without rejecting or failing to process the charge point.",
  version: "1.6",
  tags: ["reconnect", "fault-injection", "csms-resilience"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 60_000,
  async run(ctx) {
    const stormController = requireReconnectStormController(ctx);
    const { eventTimeoutMs } = ctx.profile.parameters;

    ctx.log("Configuring reconnect storm: 5 burst connections with 100ms delay, 2s between bursts");
    await stormController.setReconnectStorm({
      burstCount: 5,
      burstDelayMs: 100,
      intervalMs: 2000,
    });

    try {
      let bootCount = 0;
      const bootPromises: Array<Promise<void>> = [];

      for (let i = 0; i < 5; i++) {
        bootPromises.push(
          ctx.peer
            .waitFor(Ocpp16Action.BootNotification, eventTimeoutMs)
            .then((call) => {
              bootCount += 1;
              call.reply({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 });
              ctx.log(`BootNotification #${bootCount} received and accepted`);
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              ctx.log(`Boot waiter ended: ${message}`);
            }),
        );
      }

      ctx.log("Triggering Soft Reset to initiate storm reconnect sequence");
      await ctx.peer.call(Ocpp16Action.Reset, { type: "Soft" }, 1000).catch(() => undefined);

      await waitFor(3500);

      const received = bootCount;
      ctx.log(`Received ${received} BootNotifications during storm period`);
      assert(received >= 2, `Expected at least 2 BootNotifications during reconnect storm, got ${received}`);

      await Promise.allSettled(bootPromises);

      try {
        const finalBoot = await ctx.peer.waitFor(Ocpp16Action.BootNotification, Math.min(eventTimeoutMs, 3000));
        finalBoot.reply({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 });
      } catch {
        ctx.log("No extra Boot after clear (already settled)");
      }

      try {
        const finalStatus = await ctx.peer.waitFor(Ocpp16Action.StatusNotification, Math.min(eventTimeoutMs, 3000));
        finalStatus.reply({});
      } catch {
        ctx.log("No StatusNotification after settle");
      }

      ctx.log("Charge point stabilized after storm");
    } finally {
      ctx.log("Clearing reconnect storm configuration");
      await stormController.clearReconnectStorm();
    }
  },
});

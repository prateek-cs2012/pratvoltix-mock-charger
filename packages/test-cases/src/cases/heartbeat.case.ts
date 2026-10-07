import { Ocpp16Action } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const heartbeatCase = defineTestCase<OcppTestContext>({
  id: "heartbeat",
  title: "Heartbeat",
  description: "Trigger a Heartbeat and return the CSMS clock.",
  version: "1.6",
  tags: ["core", "trigger"],
  deployment: "external-compatible",
  timeoutMs: 15_000,
  async run(ctx) {
    const timeouts = ctx.profile.parameters;
    const incoming = ctx.peer.waitFor(Ocpp16Action.Heartbeat, timeouts.eventTimeoutMs);
    const trigger = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.TriggerMessage,
      { requestedMessage: Ocpp16Action.Heartbeat },
      timeouts.callTimeoutMs,
    );
    assertEqual(trigger.status, "Accepted", "TriggerMessage should be accepted");
    const heartbeat = await incoming;
    const currentTime = new Date().toISOString();
    heartbeat.reply({ currentTime });
    ctx.log(`Heartbeat acknowledged at ${currentTime}`);
  },
});

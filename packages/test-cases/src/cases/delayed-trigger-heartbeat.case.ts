import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert, assertEqual } from "@pratvoltix/test-runner";
import { requireSimulator, type OcppTestContext } from "../context.js";
import { defineTestCase } from "../definitions.js";
import { withFault } from "../with-fault.js";

const TIMER_SLACK_MS = 40;

export const delayedTriggerHeartbeatCase = defineTestCase<OcppTestContext>({
  id: "delayed-trigger-heartbeat",
  title: "Delayed Heartbeat trigger",
  description: "A bounded delay on TriggerMessage still accepts the Heartbeat path.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  deployment: "adapter-required",
  timeoutMs: 15_000,
  async run(ctx) {
    const delayMs = ctx.profile.parameters.simulatorDelayMs;
    await withFault(
      requireSimulator(ctx),
      {
        id: "delayed-trigger-heartbeat",
        match: { action: Ocpp16Action.TriggerMessage, occurrence: 1 },
        effect: { type: "delay", delayMs },
        consume: "once",
      },
      async () => {
        const incoming = ctx.peer.waitFor(Ocpp16Action.Heartbeat, ctx.profile.parameters.eventTimeoutMs);
        const started = Date.now();
        const trigger = await ctx.peer.call<{ status: string }>(
          Ocpp16Action.TriggerMessage,
          { requestedMessage: Ocpp16Action.Heartbeat },
          ctx.profile.parameters.callTimeoutMs,
        );
        const elapsed = Date.now() - started;
        assertEqual(trigger.status, "Accepted", "Delayed TriggerMessage should still be accepted");
        assert(
          elapsed >= Math.max(0, delayMs - TIMER_SLACK_MS),
          `TriggerMessage returned in ${elapsed}ms, before the ${delayMs}ms fault delay`,
        );
        assert(elapsed < delayMs + 4_000, `TriggerMessage took ${elapsed}ms, which is outside the lab delay bound`);
        const heartbeat = await incoming;
        heartbeat.reply({ currentTime: new Date().toISOString() });
      },
    );
  },
});

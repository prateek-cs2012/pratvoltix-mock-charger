import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireSimulator } from "../context.js";
import { withFault } from "../with-fault.js";

export const malformedResponseCase = defineTestCase<OcppTestContext>({
  id: "malformed-response",
  title: "Malformed OCPP response injection",
  description: "Injects a malformed response via fault injection to test CSMS protocol error handling. The charger sends raw invalid data instead of a valid CALLRESULT/CALLERROR.",
  version: "1.6",
  tags: ["negative", "simulator", "protocol"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const simulator = requireSimulator(ctx);
    const { callTimeoutMs } = ctx.profile.parameters;

    ctx.log("Arming malformed-response fault for Heartbeat");

    await withFault(
      simulator,
      {
        id: "malformed-heartbeat",
        consume: "once",
        match: { action: Ocpp16Action.Heartbeat, occurrence: 1 },
        effect: { type: "malformed-response", rawPayload: "not valid json at all {{{" },
      },
      async () => {
        try {
          await ctx.peer.call(
            Ocpp16Action.TriggerMessage,
            { requestedMessage: Ocpp16Action.Heartbeat },
            callTimeoutMs,
          );
        } catch {
          // Expected: TriggerMessage succeeds but Heartbeat gets malformed response
        }

        await ctx.peer.waitFor(Ocpp16Action.Heartbeat, callTimeoutMs * 2);

        ctx.log("Received Heartbeat call that will get malformed response");
        ctx.log("Malformed payload will be sent instead of valid CALLRESULT");
      },
    );

    ctx.log("Malformed response fault consumed");
  },
});

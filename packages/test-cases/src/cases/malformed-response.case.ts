import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assert } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";
import { requireSimulator } from "../context.js";
import { withFault } from "../with-fault.js";

export const malformedResponseCase = defineTestCase<OcppTestContext>({
  id: "malformed-response",
  title: "Malformed OCPP response injection",
  description: "Injects a malformed response via fault injection to test CSMS protocol error handling. The charger sends raw invalid data instead of a valid CALLRESULT/CALLERROR for an inbound CSMS call.",
  version: "1.6",
  tags: ["negative", "simulator", "protocol"],
  requirements: [SIMULATOR_CAPABILITY],
  timeoutMs: 30_000,
  async run(ctx) {
    const simulator = requireSimulator(ctx);
    const { callTimeoutMs } = ctx.profile.parameters;

    ctx.log("Arming malformed-response fault for GetConfiguration (inbound CSMS→CP)");

    await withFault(
      simulator,
      {
        id: "malformed-getconfig",
        consume: "once",
        match: { action: Ocpp16Action.GetConfiguration, occurrence: 1 },
        effect: { type: "malformed-response", rawPayload: "not valid json at all {{{" },
      },
      async () => {
        let rejected = false;
        try {
          await ctx.peer.call(
            Ocpp16Action.GetConfiguration,
            { key: [] },
            callTimeoutMs,
          );
        } catch {
          rejected = true;
        }
        assert(rejected, "GetConfiguration should have failed due to malformed response");
        ctx.log("GetConfiguration call failed as expected (malformed response sent)");
      },
    );

    ctx.log("Malformed response fault consumed");

    const normalResult = await ctx.peer.call<{ configurationKey: unknown[] }>(
      Ocpp16Action.GetConfiguration,
      { key: [] },
      callTimeoutMs,
    );
    ctx.log(`Second GetConfiguration succeeded with ${normalResult.configurationKey?.length ?? 0} keys`);
  },
});

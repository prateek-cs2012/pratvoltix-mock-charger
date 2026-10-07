import { Ocpp16Action, OcppTimeoutError } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { AssertionError } from "@pratvoltix/test-runner";
import { requireSimulator, type OcppTestContext } from "../context.js";
import { defineTestCase } from "../definitions.js";
import { withFault } from "../with-fault.js";

export const getConfigurationTimeoutCase = defineTestCase<OcppTestContext>({
  id: "get-configuration-timeout",
  title: "GetConfiguration timeout",
  description: "A suppressed GetConfiguration response times out, then a later call still succeeds.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  deployment: "adapter-required",
  timeoutMs: 15_000,
  async run(ctx) {
    await withFault(
      requireSimulator(ctx),
      {
        id: "get-configuration-timeout",
        match: { action: Ocpp16Action.GetConfiguration, occurrence: 1 },
        effect: { type: "suppress-response" },
        consume: "once",
      },
      async () => {
        try {
          await ctx.peer.call(Ocpp16Action.GetConfiguration, {}, ctx.profile.parameters.simulatorTimeoutMs);
        } catch (error) {
          if (!(error instanceof OcppTimeoutError)) {
            throw error;
          }
          return;
        }
        throw new AssertionError("GetConfiguration should time out when the response is suppressed");
      },
    );
    const recovered = await ctx.peer.call<{ configurationKey?: unknown }>(
      Ocpp16Action.GetConfiguration,
      {},
      ctx.profile.parameters.callTimeoutMs,
    );
    if (!Array.isArray(recovered.configurationKey)) {
      throw new AssertionError("GetConfiguration should answer after the one-shot fault is consumed");
    }
  },
});

import { Ocpp16Action } from "@pratvoltix/ocpp";
import { assert } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const getConfigurationCase = defineTestCase<OcppTestContext>({
  id: "get-configuration",
  title: "GetConfiguration",
  description: "Read the configured key and NumberOfConnectors from the charge point.",
  version: "1.6",
  tags: ["configuration"],
  timeoutMs: 15_000,
  async run(ctx) {
    const key = ctx.profile.parameters.configurationKey;
    const requested = key === "NumberOfConnectors" ? [key] : [key, "NumberOfConnectors"];
    const response = await ctx.peer.call<{ configurationKey?: unknown }>(
      Ocpp16Action.GetConfiguration,
      { key: requested },
      ctx.profile.parameters.callTimeoutMs,
    );
    assert(Array.isArray(response.configurationKey), "configurationKey must be an array");
    const keys = response.configurationKey.filter(
      (entry): entry is { key: string; value: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { key?: unknown }).key === "string" &&
        typeof (entry as { value?: unknown }).value === "string",
    );
    assert(keys.some((entry) => entry.key === key), `${key} was not returned`);
    if (key !== "NumberOfConnectors") {
      assert(keys.some((entry) => entry.key === "NumberOfConnectors"), "NumberOfConnectors was not returned");
    }
    ctx.log(keys.map((entry) => `${entry.key}=${entry.value}`).join(", "));
  },
});

import { AssertionError } from "@pratvoltix/test-runner";
import type { FaultRule, SimulatorController } from "@pratvoltix/simulator-control";
import { describe, expect, it } from "vitest";
import { catalog } from "./catalog.js";
import { withFault } from "./with-fault.js";

const rule: FaultRule = {
  id: "reset-once",
  match: { action: "Reset", occurrence: 1 },
  effect: { type: "call-error", errorCode: "InternalError", description: "boom" },
  consume: "once",
};

describe("withFault", () => {
  it("clears the rule after a successful operation", async () => {
    const controller = memoryController();
    await withFault(controller, rule, async () => {
      expect(await controller.listFaults()).toEqual([expect.objectContaining({ id: "reset-once" })]);
    });
    expect(await controller.listFaults()).toEqual([]);
  });

  it("clears the rule after a failed assertion and keeps the assertion error", async () => {
    const controller = memoryController();
    await expect(withFault(controller, rule, async () => {
      throw new AssertionError("expected Rejected");
    })).rejects.toMatchObject({ name: "AssertionError", message: "expected Rejected" });
    expect(await controller.listFaults()).toEqual([]);
  });

  it("treats an already consumed rule as successful cleanup", async () => {
    const controller = memoryController();
    await expect(withFault(controller, rule, async () => {
      await controller.clearFault(rule.id);
    })).resolves.toBeUndefined();
  });

  it("surfaces arm failures and cleanup failures without hiding the original error", async () => {
    const broken = memoryController();
    broken.armFault = async () => {
      throw new Error("duplicate");
    };
    await expect(withFault(broken, rule, async () => undefined)).rejects.toThrow('Failed to arm fault "reset-once": duplicate');

    const dirty = memoryController();
    dirty.clearFault = async () => {
      throw new Error("socket closed");
    };
    await expect(withFault(dirty, rule, async () => {
      throw new AssertionError("case failed");
    })).rejects.toMatchObject({
      name: "AssertionError",
      message: "case failed (fault cleanup failed: socket closed)",
    });
  });
});

describe("simulator catalog requirements", () => {
  it("keeps ordinary suites free of simulator requirements and publishes the negative suite", () => {
    const smoke = catalog.resolve({ suiteIds: ["smoke"] });
    const full = catalog.resolve({ suiteIds: ["full-ocpp16"] });
    const negative = catalog.resolve({ suiteIds: ["simulator-negative"] });
    expect(smoke.cases.every((entry) => entry.requirements.length === 0)).toBe(true);
    expect(full.cases.map((entry) => entry.id)).not.toContain("reset-call-error");
    expect(negative.cases.map((entry) => entry.id)).toEqual([
      "remote-start-rejected",
      "reset-call-error",
      "get-configuration-timeout",
      "delayed-trigger-heartbeat",
      "malformed-response",
    ]);
    expect(negative.cases.every((entry) => entry.requirements.includes("simulator-control"))).toBe(true);
    const described = catalog.describe();
    expect(described.cases.find((entry) => entry.id === "reset-call-error")?.requirements).toEqual(["simulator-control"]);
    expect(described.suites.find((entry) => entry.id === "simulator-negative")?.requirements).toEqual(["simulator-control"]);
  });
});

function memoryController(): SimulatorController {
  const faults = new Map<string, FaultRule>();
  return {
    async armFault(armed) {
      faults.set(armed.id, armed);
    },
    async clearFault(id) {
      if (!faults.delete(id)) {
        return { cleared: false, alreadyConsumed: true };
      }
      return { cleared: true, alreadyConsumed: false };
    },
    async clearAllFaults() {
      faults.clear();
    },
    async listFaults() {
      return [...faults.values()].map((armed) => ({
        id: armed.id,
        action: armed.match.action,
        occurrence: armed.match.occurrence,
        effectType: armed.effect.type,
      }));
    },
  };
}

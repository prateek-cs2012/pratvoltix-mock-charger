import { describe, expect, it } from "vitest";
import { assertEqual, runCases, runPlan, type TestCase, type TestContext } from "./index.js";

const passing: TestCase = {
  id: "passing",
  title: "Passing case",
  description: "Checks a trivial equality.",
  version: "1.6",
  tags: ["unit"],
  async run(ctx: TestContext) {
    ctx.log("checking");
    assertEqual(1 + 1, 2);
  },
};

const failing: TestCase = {
  id: "failing",
  title: "Failing case",
  description: "Fails an assertion.",
  version: "1.6",
  tags: ["unit"],
  async run() {
    assertEqual(1, 2, "numbers differ");
  },
};

const hanging: TestCase = {
  id: "hanging",
  title: "Hanging case",
  description: "Exceeds its timeout.",
  version: "1.6",
  tags: ["unit"],
  timeoutMs: 30,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 200));
  },
};

describe("runCases", () => {
  it("records pass, failure, timeout, and unknown ids", async () => {
    const report = await runCases({
      cases: [passing, failing, hanging],
      ids: ["failing", "missing", "passing", "hanging", "passing"],
      createContext: (helpers) => helpers,
    });

    expect(report.results.map((result) => result.id)).toEqual(["passing", "failing", "hanging", "missing"]);
    expect(report.results.find((result) => result.id === "passing")?.status).toBe("passed");
    expect(report.results.find((result) => result.id === "passing")?.logs.map((entry) => entry.message)).toContain(
      "checking",
    );
    expect(report.results.find((result) => result.id === "failing")?.status).toBe("failed");
    expect(report.results.find((result) => result.id === "hanging")?.error).toMatch(/timed out/);
    expect(report.results.find((result) => result.id === "missing")?.status).toBe("error");
    expect(report.status).toBe("error");
  });

  it("runs a resolved plan in step order and uses the snapshotted title and timeout", async () => {
    const report = await runPlan({
      steps: [
        { id: "failing", title: "Snapshotted failure", timeoutMs: 1_000 },
        { id: "passing" },
      ],
      cases: [passing, failing, hanging],
      createContext: (helpers) => helpers,
    });

    expect(report.results.map((result) => result.id)).toEqual(["failing", "passing"]);
    expect(report.results[0]?.title).toBe("Snapshotted failure");
    expect(report.results[0]?.status).toBe("failed");
    expect(report.status).toBe("failed");
  });
});

describe("lifecycle hooks", () => {
  it("runs start, the case, and finish in order before the next case", async () => {
    const events: string[] = [];
    const report = await runPlan({
      steps: [{ id: "passing" }, { id: "failing" }],
      cases: [
        {
          ...passing,
          async run(ctx) {
            events.push("run:passing");
            await passing.run(ctx);
          },
        },
        failing,
      ],
      createContext: (helpers) => helpers,
      lifecycle: {
        async onCaseStart(step) {
          events.push(`start:${step.id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`started:${step.id}`);
        },
        onCaseFinish(step, result) {
          events.push(`finish:${step.id}:${result.status}`);
        },
      },
    });

    expect(events).toEqual([
      "start:passing",
      "started:passing",
      "run:passing",
      "finish:passing:passed",
      "start:failing",
      "started:failing",
      "finish:failing:failed",
    ]);
    expect(report.results.map((result) => result.status)).toEqual(["passed", "failed"]);
  });

  it("still reports the case result when a lifecycle hook throws and continues the plan", async () => {
    const finished: string[] = [];
    const report = await runPlan({
      steps: [{ id: "passing" }, { id: "missing" }, { id: "failing" }],
      cases: [passing, failing],
      createContext: (helpers) => helpers,
      lifecycle: {
        onCaseStart(step) {
          if (step.id === "passing") {
            throw new Error("start hook failed");
          }
        },
        onCaseFinish(step, result) {
          finished.push(`${step.id}:${result.status}`);
          if (step.id === "missing") {
            throw new Error("finish hook failed");
          }
        },
      },
    });

    expect(finished).toEqual(["passing:passed", "missing:error", "failing:failed"]);
    expect(report.results.map((result) => `${result.id}:${result.status}`)).toEqual([
      "passing:passed",
      "missing:error",
      "failing:failed",
    ]);
    expect(report.results.find((result) => result.id === "passing")?.error).toBeUndefined();
  });
});

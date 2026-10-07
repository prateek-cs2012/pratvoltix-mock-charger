import { runPlan, type TestCase } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { catalog } from "./catalog.js";
import { createCatalog, defineScenario, defineSuite, defineTestCase } from "./definitions.js";

function fakeCase(id: string, tags: string[]): TestCase {
  return defineTestCase({
    id,
    title: id,
    description: id,
    version: "1.6",
    tags,
    async run() {
      return undefined;
    },
  });
}

describe("selection resolution", () => {
  const alpha = fakeCase("alpha", ["core"]);
  const beta = fakeCase("beta", ["configuration"]);
  const gamma = fakeCase("gamma", ["maintenance"]);
  const delta = fakeCase("delta", ["core"]);
  const reverse = defineScenario({
    id: "reverse",
    title: "Reverse",
    description: "Beta then alpha",
    version: "1.6",
    tags: ["smoke"],
    caseIds: ["beta", "alpha"],
  });
  const tail = defineScenario({
    id: "tail",
    title: "Tail",
    description: "Gamma then delta",
    version: "1.6",
    tags: ["smoke"],
    caseIds: ["gamma", "delta"],
  });
  const sample = createCatalog({
    version: "test",
    cases: [alpha, beta, gamma, delta],
    scenarios: [reverse, tail],
    suites: [
      defineSuite({
        id: "explicit",
        title: "Explicit",
        description: "Cases in declared order",
        version: "1.6",
        tags: ["regression"],
        caseIds: ["gamma", "alpha", "beta"],
      }),
      defineSuite({
        id: "composed",
        title: "Composed",
        description: "Scenarios in declared order",
        version: "1.6",
        tags: ["smoke"],
        scenarioIds: ["tail", "reverse"],
      }),
      defineSuite({
        id: "tagged",
        title: "Tagged",
        description: "Core and configuration, without maintenance",
        version: "1.6",
        tags: ["regression"],
        includeTags: ["core", "configuration", "maintenance"],
        excludeTags: ["maintenance"],
      }),
      defineSuite({
        id: "mixed",
        title: "Mixed",
        description: "Explicit cases, then scenarios, then tags",
        version: "1.6",
        tags: ["smoke"],
        caseIds: ["gamma"],
        scenarioIds: ["reverse"],
        includeTags: ["core"],
      }),
    ],
  });

  it("resolves a scenario in declared case order", () => {
    const plan = sample.resolve({ scenarioIds: ["reverse"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["beta", "alpha"]);
  });

  it("executes requested scenarios in request order", () => {
    const plan = sample.resolve({ scenarioIds: ["tail", "reverse"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["gamma", "delta", "beta", "alpha"]);
  });

  it("preserves a suite's explicit case order", () => {
    const plan = sample.resolve({ suiteIds: ["explicit"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["gamma", "alpha", "beta"]);
    expect(plan.cases[0]?.origins).toEqual([{ type: "suite", id: "explicit", title: "Explicit" }]);
  });

  it("preserves suite scenario order and each scenario's case order", () => {
    const plan = sample.resolve({ suiteIds: ["composed"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["gamma", "delta", "beta", "alpha"]);
    expect(plan.cases[0]?.origins).toEqual([
      { type: "suite", id: "composed", title: "Composed" },
      { type: "scenario", id: "tail", title: "Tail" },
    ]);
    expect(plan.cases[2]?.origins).toEqual([
      { type: "suite", id: "composed", title: "Composed" },
      { type: "scenario", id: "reverse", title: "Reverse" },
    ]);
  });

  it("selects tagged cases in catalog registration order and drops excluded tags", () => {
    const plan = sample.resolve({ suiteIds: ["tagged"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["alpha", "beta", "delta"]);
  });

  it("executes a duplicate case once and merges later origins without moving it", () => {
    const plan = sample.resolve({
      suiteIds: ["explicit"],
      scenarioIds: ["reverse"],
      caseIds: ["alpha", "alpha"],
    });

    expect(plan.cases.map((entry) => entry.id)).toEqual(["gamma", "alpha", "beta"]);
    expect(plan.cases.find((entry) => entry.id === "alpha")?.origins).toEqual([
      { type: "suite", id: "explicit", title: "Explicit" },
      { type: "scenario", id: "reverse", title: "Reverse" },
      { type: "case", id: "alpha", title: "alpha" },
    ]);
    expect(plan.selection).toEqual({
      caseIds: ["alpha"],
      scenarioIds: ["reverse"],
      suiteIds: ["explicit"],
    });
    expect(plan.catalogVersion).toBe("test");
  });

  it("walks suites, then scenarios, then direct cases, keeping the first position", () => {
    const plan = sample.resolve({
      suiteIds: ["mixed", "tagged"],
      scenarioIds: ["tail"],
      caseIds: ["beta"],
    });

    expect(plan.cases.map((entry) => entry.id)).toEqual(["gamma", "beta", "alpha", "delta"]);
    expect(plan.cases.find((entry) => entry.id === "beta")?.origins).toEqual([
      { type: "suite", id: "mixed", title: "Mixed" },
      { type: "scenario", id: "reverse", title: "Reverse" },
      { type: "suite", id: "tagged", title: "Tagged" },
      { type: "case", id: "beta", title: "beta" },
    ]);
    expect(plan.cases.find((entry) => entry.id === "alpha")?.origins).toEqual([
      { type: "suite", id: "mixed", title: "Mixed" },
      { type: "scenario", id: "reverse", title: "Reverse" },
      { type: "suite", id: "tagged", title: "Tagged" },
    ]);
    expect(plan.cases.find((entry) => entry.id === "delta")?.origins).toEqual([
      { type: "suite", id: "mixed", title: "Mixed" },
      { type: "suite", id: "tagged", title: "Tagged" },
      { type: "scenario", id: "tail", title: "Tail" },
    ]);
  });

  it("names the offending id when a selection is ambiguous or unknown", () => {
    expect(() => sample.resolve({ caseIds: ["reverse"] })).toThrow(
      /Case "reverse" was not found. A scenario with that id exists/,
    );
    expect(() => sample.resolve({})).toThrow(/Selection is empty/);
    expect(() => sample.resolve({ suiteIds: ["missing-suite"] })).toThrow(/Suite "missing-suite" was not found/);
  });

  it("runs the resolved plan in that order even when catalog registration differs", async () => {
    const seen: string[] = [];
    const ordered = createCatalog({
      version: "test",
      cases: [
        defineTestCase({
          id: "alpha",
          title: "Alpha",
          description: "Registered first",
          version: "1.6",
          tags: ["core"],
          async run() {
            seen.push("alpha");
          },
        }),
        defineTestCase({
          id: "beta",
          title: "Beta",
          description: "Registered second",
          version: "1.6",
          tags: ["core"],
          async run() {
            seen.push("beta");
          },
        }),
      ],
      scenarios: [
        defineScenario({
          id: "reversed",
          title: "Reversed",
          description: "Beta before alpha",
          version: "1.6",
          tags: ["smoke"],
          caseIds: ["beta", "alpha"],
        }),
      ],
      suites: [],
    });
    const plan = ordered.resolve({ scenarioIds: ["reversed"] });
    const report = await runPlan({
      steps: plan.cases.map((entry) => ({ id: entry.id, title: entry.title, timeoutMs: entry.timeoutMs })),
      cases: [...ordered.cases],
      createContext: (helpers) => helpers,
    });

    expect(plan.cases.map((entry) => entry.id)).toEqual(["beta", "alpha"]);
    expect(report.results.map((result) => result.id)).toEqual(["beta", "alpha"]);
    expect(seen).toEqual(["beta", "alpha"]);
  });
});

describe("ocpp 1.6 catalog selection", () => {
  it("keeps soft reset last in the full regression suite", () => {
    const plan = catalog.resolve({ suiteIds: ["full-ocpp16"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual([
      "boot-notification",
      "heartbeat",
      "status-notification",
      "get-configuration",
      "change-configuration",
      "transaction-lifecycle",
      "soft-reset",
    ]);
    expect(plan.cases.at(-1)?.id).toBe("soft-reset");
    expect(plan.catalogVersion).toBe("1");
  });

  it("resolves the smoke suite to boot, heartbeat, and status", () => {
    const plan = catalog.resolve({ suiteIds: ["smoke"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual([
      "boot-notification",
      "heartbeat",
      "status-notification",
    ]);
    expect(plan.cases[0]?.origins).toEqual([
      { type: "suite", id: "smoke", title: "Smoke" },
      { type: "scenario", id: "smoke", title: "Boot and register" },
    ]);
  });

  it("resolves the configuration suite from tags", () => {
    const plan = catalog.resolve({ suiteIds: ["configuration"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual(["get-configuration", "change-configuration"]);
  });

  it("removes a case that is requested both directly and through a scenario", () => {
    const plan = catalog.resolve({ scenarioIds: ["smoke"], caseIds: ["heartbeat"] });
    expect(plan.cases.map((entry) => entry.id)).toEqual([
      "boot-notification",
      "heartbeat",
      "status-notification",
    ]);
    expect(plan.cases.filter((entry) => entry.id === "heartbeat")).toHaveLength(1);
    expect(plan.cases.find((entry) => entry.id === "heartbeat")?.origins).toEqual([
      { type: "scenario", id: "smoke", title: "Boot and register" },
      { type: "case", id: "heartbeat", title: "Heartbeat" },
    ]);
  });
});

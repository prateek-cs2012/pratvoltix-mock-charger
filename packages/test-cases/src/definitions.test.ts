import type { TestCase } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { CatalogError, createCatalog, defineScenario, defineSuite, defineTestCase } from "./definitions.js";

function fakeCase(id: string, tags: string[] = ["core"], version: "1.6" | "2.0.1" = "1.6"): TestCase {
  return defineTestCase({
    id,
    title: id,
    description: `${id} description`,
    version,
    tags,
    async run() {
      return undefined;
    },
  });
}

describe("catalog definitions", () => {
  it("rejects an unsupported protocol version", () => {
    expect(() =>
      defineTestCase({
        id: "heartbeat",
        title: "Heartbeat",
        description: "Beat",
        version: "1.5" as "1.6",
        tags: ["core"],
        async run() {
          return undefined;
        },
      }),
    ).toThrow(/Case "heartbeat" has unsupported protocol version "1.5"/);
  });

  it("rejects duplicate ids within a definition type", () => {
    const heartbeat = fakeCase("heartbeat");
    expect(() =>
      createCatalog({
        version: "1",
        cases: [heartbeat, heartbeat],
        scenarios: [],
        suites: [defineSuite({
          id: "only",
          title: "Only",
          description: "One case",
          version: "1.6",
          tags: ["core"],
          caseIds: ["heartbeat"],
        })],
      }),
    ).toThrow(CatalogError);
    expect(() =>
      createCatalog({
        version: "1",
        cases: [heartbeat, { ...heartbeat }],
        scenarios: [],
        suites: [],
      }),
    ).toThrow(/Duplicate case id "heartbeat"/);
  });

  it("rejects missing case and scenario references", () => {
    const heartbeat = fakeCase("heartbeat");
    expect(() =>
      createCatalog({
        version: "1",
        cases: [heartbeat],
        scenarios: [
          defineScenario({
            id: "smoke",
            title: "Smoke",
            description: "Smoke path",
            version: "1.6",
            tags: ["smoke"],
            caseIds: ["missing-case"],
          }),
        ],
        suites: [],
      }),
    ).toThrow(/Scenario "smoke" references missing case "missing-case"/);

    const scenario = defineScenario({
      id: "smoke",
      title: "Smoke",
      description: "Smoke path",
      version: "1.6",
      tags: ["smoke"],
      caseIds: ["heartbeat"],
    });
    const nested = defineSuite({
      id: "wrapper",
      title: "Wrapper",
      description: "Tries to nest a suite",
      version: "1.6",
      tags: ["smoke"],
      scenarioIds: ["full-ocpp16"],
    });
    expect(() =>
      createCatalog({
        version: "1",
        cases: [heartbeat],
        scenarios: [scenario],
        suites: [
          defineSuite({
            id: "full-ocpp16",
            title: "Full",
            description: "All",
            version: "1.6",
            tags: ["regression"],
            caseIds: ["heartbeat"],
          }),
          nested,
        ],
      }),
    ).toThrow(/Suite "wrapper" references missing scenario "full-ocpp16". Suites cannot contain other suites/);
  });

  it("rejects empty scenarios and suites", () => {
    expect(() =>
      defineScenario({
        id: "smoke",
        title: "Smoke",
        description: "Empty",
        version: "1.6",
        tags: ["smoke"],
        caseIds: [],
      }),
    ).toThrow(/Scenario "smoke" does not reference any cases/);

    const heartbeat = fakeCase("heartbeat");
    expect(() =>
      createCatalog({
        version: "1",
        cases: [heartbeat],
        scenarios: [],
        suites: [
          defineSuite({
            id: "nothing",
            title: "Nothing",
            description: "Excluded everything",
            version: "1.6",
            tags: ["core"],
            caseIds: ["heartbeat"],
            excludeTags: ["core"],
          }),
        ],
      }),
    ).toThrow(/Suite "nothing" resolves to no cases/);
  });
});

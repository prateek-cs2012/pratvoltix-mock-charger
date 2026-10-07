import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeForRun, parseArgs } from "./args.js";
import { executeCli, type CliIo } from "./cli.js";

describe("parseArgs", () => {
  it("parses catalog, run, and show commands", () => {
    expect(parseArgs(["catalog", "list", "--type", "case", "--json"], {}).kind).toBe("catalog-list");
    expect(parseArgs(["catalog", "list", "--type=scenario"], {})).toMatchObject({ type: "scenario" });
    expect(parseArgs(["catalog", "validate"], {})).toMatchObject({ kind: "catalog-validate" });
    expect(
      parseArgs(["run", "--station", "CP001", "--case", "heartbeat", "--suite", "smoke", "--wait"], {}),
    ).toMatchObject({
      kind: "run",
      station: "CP001",
      caseIds: ["heartbeat"],
      suiteIds: ["smoke"],
      options: { wait: true, apiUrl: "http://localhost:8080" },
    });
    expect(parseArgs(["runs", "show", "abc"], { LAB_API_URL: "http://lab.example" }).options?.apiUrl).toBe(
      "http://lab.example",
    );
  });

  it("rejects incomplete run commands", () => {
    expect(() => parseArgs(["run", "--case", "heartbeat"], {})).toThrow(/Missing required flag --station/);
    expect(() => parseArgs(["run", "--station", "CP001"], {})).toThrow(/at least one --case/);
    expect(parseArgs(["run", "--station", "CP001", "--suite", "smoke", "--target-mode", "external", "--target-url", "ws://host.docker.internal:9101/independent/{stationId}"], {})).toMatchObject({
      target: { mode: "external", urlTemplate: "ws://host.docker.internal:9101/independent/{stationId}" },
    });
    expect(parseArgs(["run", "--station", "CP001", "--suite", "smoke", "--target-mode", "embedded"], {})).toMatchObject({
      target: { mode: "embedded" },
    });
    expect(() => parseArgs(["run", "--station", "CP001", "--suite", "smoke", "--target-mode", "external"], {})).toThrow(/requires --target-url/);
    try {
      parseArgs(["run", "--station", "CP001", "--suite", "smoke", "--target-url", "http://user:secret@csms.example/ocpp/{stationId}"], {});
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/ws: or wss:/);
      expect((error as Error).message).not.toContain("secret");
      expect((error as { exitCode?: number }).exitCode).toBe(6);
    }
    expect(() => parseArgs(["catalog", "list", "--type", "plugin"], {})).toThrow(/--type must be case/);
    expect(() => parseArgs(["runs", "show"], {})).toThrow(/requires a run id/);
  });
});

describe("exitCodeForRun", () => {
  it("maps terminal statuses and timeouts", () => {
    expect(exitCodeForRun("passed")).toBe(0);
    expect(exitCodeForRun("failed")).toBe(1);
    expect(exitCodeForRun("error")).toBe(2);
    expect(exitCodeForRun("running", true)).toBe(3);
  });
});

describe("executeCli", () => {
  it("prints catalog JSON from the API", async () => {
    const io = fakeIo(async () =>
      json({
        version: "1",
        cases: [{ id: "heartbeat", title: "Heartbeat", tags: ["core"] }],
        scenarios: [],
        suites: [],
      }),
    );
    const code = await executeCli(["catalog", "list", "--type", "case", "--json"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('"id": "heartbeat"');
  });

  it("returns the status exit code after --wait", async () => {
    const failed = await waitFor("failed");
    const errored = await waitFor("error");
    const passed = await waitFor("passed");
    expect(failed).toBe(1);
    expect(errored).toBe(2);
    expect(passed).toBe(0);
  });

  it("returns 3 when a waited run does not finish", async () => {
    let clock = 0;
    const io = fakeIo(async (url, init) => {
      if (init?.method === "POST") {
        return json({ id: "run-1", chargePointIdentity: "CP001", status: "queued", results: [] });
      }
      return json({ id: "run-1", chargePointIdentity: "CP001", status: "running", results: [] });
    }, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const code = await executeCli(
      ["run", "--station", "CP001", "--case", "heartbeat", "--wait", "--timeout-ms", "2500", "--interval-ms", "1000"],
      io,
    );
    expect(code).toBe(3);
    expect(io.err()).toMatch(/Timed out waiting for run run-1/);
  });

  it("prints JSON errors and a non-zero code when the API rejects a selection", async () => {
    const io = fakeIo(async () => json({ error: 'Case "missing" was not found.' }, 400));
    const code = await executeCli(["run", "--station", "CP001", "--case", "missing", "--json"], io);
    expect(code).toBe(1);
    expect(io.err()).toContain('Case \\"missing\\" was not found.');
  });

  it("parses trace filters and rejects invalid ones", async () => {
    expect(
      parseArgs(
        [
          "runs",
          "trace",
          "run-1",
          "--case",
          "heartbeat",
          "--action",
          "Heartbeat",
          "--direction",
          "charge-point-to-csms",
          "--message-type",
          "CALL",
          "--json",
        ],
        {},
      ),
    ).toMatchObject({
      kind: "runs-trace",
      id: "run-1",
      caseId: "heartbeat",
      action: "Heartbeat",
      direction: "charge-point-to-csms",
      messageType: "CALL",
      options: { json: true },
    });
    expect(() => parseArgs(["runs", "trace"], {})).toThrow(/requires a run id/);
    expect(() => parseArgs(["runs", "trace", "run-1", "--direction", "up"], {})).toThrow(/--direction must be/);
    expect(() => parseArgs(["runs", "trace", "run-1", "--message-type", "PING"], {})).toThrow(/--message-type must be/);
    expect(() => parseArgs(["runs", "list", "--action", "Heartbeat"], {})).toThrow(/only valid for runs trace/);
    const rejected = fakeIo(async () => json({}));
    expect(await executeCli(["runs", "trace", "run-1", "--message-type", "PING"], rejected)).toBe(1);
    expect(rejected.err()).toMatch(/--message-type must be/);
  });

  it("prints a human trace, JSON without dropping fields, and a truncation warning", async () => {
    const body = {
      runId: "run-1",
      summary: { capturedEntries: 1, droppedEntries: 2, truncatedEntries: 1, truncated: true },
      entries: [
        {
          sequence: 4,
          at: "2026-10-06T12:00:00.000Z",
          direction: "charge-point-to-csms",
          messageType: "CALL",
          action: "Heartbeat",
          uniqueId: "uid-9",
          caseId: "heartbeat",
          payload: { currentTime: "2026-10-06T12:00:00.000Z" },
          originalRawBytes: 90000,
          vendorNote: "kept",
        },
      ],
    };
    let requested = "";
    const human = fakeIo(async (url) => {
      requested = String(url);
      return json(body);
    });
    expect(await executeCli(["runs", "trace", "run-1", "--case", "heartbeat", "--action", "Heartbeat"], human)).toBe(0);
    expect(requested).toContain("/api/runs/run-1/trace?");
    expect(requested).toContain("caseId=heartbeat");
    expect(requested).toContain("action=Heartbeat");
    expect(human.out()).toMatch(/Warning: trace is incomplete/);
    expect(human.out()).toContain("4");
    expect(human.out()).toContain("2026-10-06T12:00:00.000Z");
    expect(human.out()).toContain("charge-point-to-csms");
    expect(human.out()).toContain("CALL");
    expect(human.out()).toContain("Heartbeat");
    expect(human.out()).toContain("uid-9");
    expect(human.out()).toContain("heartbeat");
    expect(human.out()).toContain("currentTime");
    expect(human.out()).toContain("raw truncated from 90000 bytes");

    const machine = fakeIo(async () => json(body));
    expect(await executeCli(["runs", "trace", "run-1", "--json"], machine)).toBe(0);
    expect(JSON.parse(machine.out())).toEqual(body);
  });

  it("lists and shows simulators in text and JSON", async () => {
    expect(parseArgs(["simulators", "list", "--json"], {})).toMatchObject({ kind: "simulators-list", options: { json: true } });
    expect(parseArgs(["simulators", "show", "CP001"], {})).toMatchObject({ kind: "simulators-show", identity: "CP001" });
    expect(() => parseArgs(["simulators", "show"], {})).toThrow(/requires an identity/);

    const body = [{
      identity: "CP001",
      connected: true,
      protocolVersion: "1",
      simulatorName: "Pratvoltix Mock",
      simulatorVersion: "0.1.0",
      capabilities: ["simulator-control"],
      activeFaults: [{ id: "reset-call-error", action: "Reset", occurrence: 1, effectType: "call-error" }],
      lastCleanup: { ok: true, at: "2026-10-06T00:00:00.000Z" },
      secretPayload: { status: "Rejected" },
    }];
    const human = fakeIo(async () => json(body));
    expect(await executeCli(["simulators", "list"], human)).toBe(0);
    expect(human.out()).toContain("CP001");
    expect(human.out()).toContain("connected");
    expect(human.out()).toContain("protocol 1");
    expect(human.out()).toContain("Pratvoltix Mock 0.1.0");
    expect(human.out()).toContain("simulator-control");
    expect(human.out()).toContain("faults 1");
    expect(human.out()).toContain("cleanup ok");

    const machine = fakeIo(async () => json(body[0]));
    expect(await executeCli(["simulators", "show", "CP001", "--json"], machine)).toBe(0);
    expect(JSON.parse(machine.out())).toEqual(body[0]);
  });

  it("loads, validates, and resolves profile files and applies typed overrides", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pratvoltix-profile-"));
    const file = path.join(directory, "bench.json");
    const envFile = path.join(directory, "env.json");
    writeFileSync(file, JSON.stringify({
      schemaVersion: "1",
      name: "bench-charger",
      parameters: { idTag: "LAB-CARD-002" },
    }));
    writeFileSync(envFile, JSON.stringify({ schemaVersion: "1", name: "from-env", parameters: { connectorId: 3 } }));
    writeFileSync(path.join(directory, "broken.json"), "{");

    expect(parseArgs(["profiles", "show-default"], {})).toMatchObject({ kind: "profiles-show-default" });
    expect(parseArgs(["run", "--station", "CP001", "--suite", "smoke"], { LAB_PROFILE: envFile })).toMatchObject({
      kind: "run",
      profilePath: envFile,
    });
    expect(parseArgs(["run", "--station", "CP001", "--suite", "smoke", "--profile", file], { LAB_PROFILE: envFile })).toMatchObject({
      kind: "run",
      profilePath: file,
    });
    expect(() => parseArgs(["run", "--station", "CP001", "--case", "heartbeat", "--set", "idTag=A", "--set", "idTag=B"], {})).toThrow(/Duplicate override/);
    expect(() => parseArgs(["runs", "list", "--set", "idTag=A"], {})).toThrow(/only valid for run and ci run/);

    const shown = fakeIo(async () => json({}));
    expect(await executeCli(["profiles", "show-default", "--json"], shown)).toBe(0);
    expect(JSON.parse(shown.out()).parameters.idTag).toBe("TEST-TAG-001");

    const validated = fakeIo(async () => json({}));
    expect(await executeCli(["profiles", "validate", file], validated)).toBe(0);
    expect(validated.out()).toContain("bench-charger");

    const resolved = fakeIo(async () => json({}));
    expect(await executeCli(["profiles", "resolve", file, "--json"], resolved)).toBe(0);
    const resolvedBody = JSON.parse(resolved.out()) as { name: string; parameters: { idTag: string; connectorId: number } };
    expect(resolvedBody.name).toBe("bench-charger");
    expect(resolvedBody.parameters.idTag).toBe("LAB-CARD-002");
    expect(resolvedBody.parameters.connectorId).toBe(1);

    const missing = fakeIo(async () => json({}));
    expect(await executeCli(["profiles", "validate", path.join(directory, "missing.json")], missing)).toBe(1);
    expect(missing.err()).toMatch(/Cannot read profile file/);

    const broken = fakeIo(async () => json({}));
    expect(await executeCli(["profiles", "validate", path.join(directory, "broken.json")], broken)).toBe(1);
    expect(broken.err()).toMatch(/not valid JSON/);

    let posted = "";
    const queued = fakeIo(async (_url, init) => {
      posted = String(init?.body);
      return json({
        id: "run-9",
        chargePointIdentity: "CP001",
        status: "queued",
        profile: {
          schemaVersion: "1",
          name: "bench-charger",
          parameters: { idTag: "LAB-CARD-004", connectorId: 1 },
        },
        results: [],
      });
    });
    expect(await executeCli(["run", "--station", "CP001", "--suite", "smoke", "--profile", file, "--set", "idTag=LAB-CARD-004"], queued)).toBe(0);
    const request = JSON.parse(posted) as { profile: { name: string }; overrides: { idTag: string } };
    expect(request.profile.name).toBe("bench-charger");
    expect(request.overrides.idTag).toBe("LAB-CARD-004");
    expect(queued.out()).toContain("using profile bench-charger");
    expect(await executeCli(["run", "--station", "CP001", "--case", "heartbeat", "--set", "connectorId=1.5"], fakeIo(async () => json({})))).toBe(1);
  });

  it("follows trace pages until the transcript is complete", async () => {
    const seen: string[] = [];
    const io = fakeIo(async (url) => {
      seen.push(String(url));
      if (!String(url).includes("afterSequence")) {
        return json({
          runId: "run-1",
          summary: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
          entries: [{ sequence: 1, at: "2026-10-06T00:00:00.000Z", direction: "csms-to-charge-point", messageType: "CALL", action: "Heartbeat" }],
          page: { limit: 500, returned: 1, nextAfterSequence: 1, hasMore: true },
        });
      }
      return json({
        runId: "run-1",
        summary: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
        entries: [{ sequence: 2, at: "2026-10-06T00:00:01.000Z", direction: "charge-point-to-csms", messageType: "CALLRESULT", action: "Heartbeat" }],
        page: { limit: 500, returned: 1, nextAfterSequence: null, hasMore: false },
      });
    });
    expect(await executeCli(["runs", "trace", "run-1", "--json"], io)).toBe(0);
    const body = JSON.parse(io.out()) as { entries: Array<{ sequence: number }> };
    expect(body.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(seen[1]).toContain("afterSequence=1");
  });
});

async function waitFor(status: string): Promise<number> {
  let clock = 0;
  const io = fakeIo(
    async (_url, init) => {
      if (init?.method === "POST") {
        return json({ id: "run-1", chargePointIdentity: "CP001", status: "queued", results: [] });
      }
      return json({
        id: "run-1",
        chargePointIdentity: "CP001",
        status,
        results: [{ id: "heartbeat", title: "Heartbeat", status }],
      });
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  return executeCli(["run", "--station", "CP001", "--suite", "smoke", "--wait", "--json"], io);
}

function fakeIo(
  fetchImpl: typeof fetch,
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): CliIo & { out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    fetch: fetchImpl,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    sleep: clock.sleep ?? (async () => undefined),
    now: clock.now ?? (() => 0),
    env: {},
    out: () => stdout,
    err: () => stderr,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

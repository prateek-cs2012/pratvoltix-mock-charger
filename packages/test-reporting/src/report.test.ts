import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderBundle, renderJunit, sha256Hex } from "./index.js";

const generatedAt = "2026-10-06T00:00:00.000Z";

describe("run reports", () => {
  it("stores a sanitized target snapshot in run.json", () => {
    const rendered = renderBundle({
      run: {
        ...passedRun(),
        target: {
          mode: "external",
          configurationSource: "run",
          urlTemplate: "wss://user:secret@csms.example/ocpp/{stationId}?token=secret",
          resolvedEndpoint: "wss://user:secret@csms.example/ocpp/CP001?token=secret",
          stationIdentity: "CP001",
          requestedSubprotocol: "ocpp1.6",
          negotiatedSubprotocol: "ocpp1.6",
        },
      },
      generatedAt,
      traceRequested: false,
    });
    const run = file(rendered, "run.json");
    expect(run).toContain("\"resolvedEndpoint\": \"wss://csms.example/ocpp/CP001?token=redacted\"");
    expect(run).toContain("\"urlTemplate\": \"wss://csms.example/ocpp/{stationId}?token=redacted\"");
    expect(run).not.toContain("secret");
  });

  it("renders a passed run with stable JUnit, hashes, and injected time", () => {
    const first = renderBundle({ run: passedRun(), trace: trace(), generatedAt, traceRequested: true });
    const second = renderBundle({ run: passedRun(), trace: trace(), generatedAt, traceRequested: true });
    expect(first.files.map((file) => file.contents)).toEqual(second.files.map((file) => file.contents));
    expect(first.files.at(-1)?.name).toBe("manifest.json");
    const junit = file(first, "junit.xml");
    expect(junit).toContain('tests="2"');
    expect(junit).toContain('failures="0"');
    expect(junit).toContain('errors="0"');
    expect(junit).toContain('time="1.004"');
    expect(junit.indexOf('name="Heartbeat ハート"')).toBeLessThan(junit.indexOf('name="Status"'));
    expect(junit).toContain('name="case.id" value="heartbeat"');
    expect(junit).toContain('name="case.version" value="1.6"');
    expect(junit).toContain('name="case.tags" value="core"');
    expect(junit).toContain('name="case.origins" value="suite:smoke"');
    expect(junit).toContain('name="profile.name" value="default-ocpp16"');
    expect(junit).toContain('name="selection.suiteIds" value="smoke"');
    expect(junit).toContain("<system-out>2026-10-06T00:00:01.000Z started red</system-out>");
    expect(junit).not.toContain("\u001b");
    expect(junit).toContain("ハート");
    const manifest = JSON.parse(file(first, "manifest.json")) as {
      generatedAt: string;
      artifacts: Array<{ name: string; sha256: string; bytes: number }>;
    };
    expect(manifest.generatedAt).toBe(generatedAt);
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      "junit.xml",
      "run.json",
      "summary.txt",
      "trace-summary.json",
      "trace.ndjson",
    ]);
    for (const artifact of manifest.artifacts) {
      const contents = file(first, artifact.name);
      expect(artifact.sha256).toBe(sha256Hex(contents));
      expect(artifact.bytes).toBe(Buffer.byteLength(contents));
      expect(artifact.sha256).toBe(createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex"));
    }
    expect(file(first, "run.json")).not.toContain('"entries"');
    expect(file(first, "summary.txt")).toContain("Status passed");
    expect(file(first, "summary.txt")).toContain("passed heartbeat 4 ms Heartbeat");
  });

  it("maps failed and error cases and escapes XML", () => {
    const failed = renderJunit(renderBundle({ run: outcomeRun("failed", 'expected <ok> & "yes"\u0001'), trace: trace(), generatedAt, traceRequested: true }).run);
    expect(failed).toContain("<failure");
    expect(failed).toContain("expected &lt;ok&gt; &amp; &quot;yes&quot;");
    expect(failed).not.toContain("\u0001");
    expect(failed).toContain("<system-err>2026-10-06T00:00:01.100Z broken &lt;tag&gt;</system-err>");
    const errored = renderJunit(renderBundle({ run: outcomeRun("error", "boom"), trace: trace(), generatedAt, traceRequested: true }).run);
    expect(errored).toContain("<error");
    expect(errored).toContain('errors="1"');
  });

  it("exports an empty trace for a historical run and omits trace files when not requested", () => {
    const historical = renderBundle({
      run: {
        id: "legacy1",
        chargePointIdentity: "CP001",
        status: "passed",
        createdAt: "2026-10-06T00:00:00.000Z",
        selection: null,
        plan: null,
        profile: null,
        summary: { total: 1, passed: 1, failed: 0, error: 0 },
        results: [{ id: "heartbeat", title: "Heartbeat", status: "passed", durationMs: 4, logs: [] }],
      },
      trace: { runId: "legacy1", summary: { capturedEntries: 0, droppedEntries: 0, truncatedEntries: 0, truncated: false }, entries: [] },
      generatedAt,
      traceRequested: true,
    });
    expect(file(historical, "trace.ndjson")).toBe("");
    expect(file(historical, "junit.xml")).toContain("Pratvoltix OCPP · CP001 · historical");
    expect(file(historical, "summary.txt")).toContain("Profile none");
    const lines = file(renderBundle({
      run: passedRun(),
      trace: trace(),
      generatedAt,
      traceRequested: true,
    }), "trace.ndjson").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).sequence)).toEqual([1, 2]);

    const without = renderBundle({ run: passedRun(), generatedAt, traceRequested: false });
    expect(without.files.map((entry) => entry.name)).toEqual(["run.json", "junit.xml", "summary.txt", "manifest.json"]);
    const manifest = JSON.parse(file(without, "manifest.json")) as { traceExport: string };
    expect(manifest.traceExport).toBe("not-requested");
    expect(file(without, "summary.txt")).toContain("Trace export was not requested.");
  });

  it("rejects a malformed report and records a trace policy failure", () => {
    expect(() => renderBundle({ run: { id: "run1" }, generatedAt, traceRequested: false })).toThrow(/chargePointIdentity/);
    const truncated = renderBundle({
      run: passedRun(),
      trace: { ...trace(), summary: { capturedEntries: 0, droppedEntries: 1, truncatedEntries: 1, truncated: true } },
      generatedAt,
      traceRequested: true,
      failOnTruncatedTrace: true,
      requireTrace: true,
    });
    expect(truncated.policy.passed).toBe(false);
    expect(file(truncated, "summary.txt")).toContain("Trace policy failed: --require-trace");
    expect(file(truncated, "summary.txt")).toContain("Warning: stored trace is truncated.");
    const manifest = JSON.parse(file(truncated, "manifest.json")) as { tracePolicy: { passed: boolean } };
    expect(manifest.tracePolicy.passed).toBe(false);
  });
});

function file(bundle: { files: Array<{ name: string; contents: string }> }, name: string): string {
  const found = bundle.files.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`missing ${name}`);
  }
  return found.contents;
}

function passedRun() {
  return outcomeRun("passed");
}

function outcomeRun(status: "passed" | "failed" | "error", error = "failed") {
  const failed = status !== "passed";
  return {
    id: "run1",
    chargePointIdentity: "CP001",
    status,
    createdAt: "2026-10-06T00:00:00.000Z",
    startedAt: "2026-10-06T00:00:01.000Z",
    finishedAt: "2026-10-06T00:00:02.000Z",
    selection: { caseIds: [], scenarioIds: [], suiteIds: ["smoke"] },
    plan: {
      catalogVersion: "1",
      cases: [
        {
          id: "heartbeat",
          title: "Heartbeat",
          description: "Trigger a Heartbeat.",
          version: "1.6",
          tags: ["core"],
          timeoutMs: 15000,
          origins: [{ type: "suite", id: "smoke", title: "Smoke" }],
        },
        {
          id: "status-notification",
          title: "Status",
          description: "Read status.",
          version: "1.6",
          tags: ["core"],
          requirements: ["simulator-control"],
          timeoutMs: 15000,
          origins: [{ type: "suite", id: "smoke", title: "Smoke" }],
        },
      ],
    },
    profile: {
      schemaVersion: "1",
      name: "default-ocpp16",
      parameters: { connectorId: 1, idTag: "TEST-TAG-001" },
    },
    summary: {
      total: 2,
      passed: failed ? 1 : 2,
      failed: status === "failed" ? 1 : 0,
      error: status === "error" ? 1 : 0,
    },
    results: [
      {
        id: "heartbeat",
        title: "Heartbeat ハート",
        status: "passed",
        durationMs: 4,
        logs: [{ level: "info", message: "started \u001b[31mred\u001b[0m", at: "2026-10-06T00:00:01.000Z" }],
      },
      {
        id: "status-notification",
        title: "Status",
        status,
        durationMs: 1000,
        ...(failed ? { error } : {}),
        logs: failed ? [{ level: "error", message: "broken <tag>", at: "2026-10-06T00:00:01.100Z" }] : [],
      },
    ],
    trace: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
  };
}

function trace() {
  return {
    runId: "run1",
    summary: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
    entries: [
      { sequence: 1, at: "2026-10-06T00:00:01.000Z", direction: "csms-to-charge-point", messageType: "CALL", action: "Heartbeat", payload: {} },
      { sequence: 2, at: "2026-10-06T00:00:01.100Z", direction: "charge-point-to-csms", messageType: "CALLRESULT", action: "Heartbeat", payload: { currentTime: "2026-10-06T00:00:01.100Z" } },
    ],
  };
}

import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderBundle } from "@pratvoltix/test-reporting";
import { executeCli, type CliIo } from "./cli.js";
import { writeArtifacts } from "./export.js";

describe("artifact files", () => {
  it("writes a new bundle, rejects a second write, and overwrites only known files", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pratvoltix-artifacts-"));
    const files = renderBundle({
      run: sampleRun(),
      trace: sampleTrace(),
      generatedAt: "2026-10-06T00:00:00.000Z",
      traceRequested: true,
    }).files;
    const directory = await writeArtifacts(root, "run1", files, false);
    expect(path.basename(directory)).toBe("run1");
    expect(readdirSync(directory).filter((name) => !name.startsWith(".")).sort()).toEqual([
      "junit.xml",
      "manifest.json",
      "run.json",
      "summary.txt",
      "trace-summary.json",
      "trace.ndjson",
    ]);
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as {
      artifacts: Array<{ name: string; sha256: string }>;
    };
    for (const artifact of manifest.artifacts) {
      const contents = readFileSync(path.join(directory, artifact.name));
      expect(createHash("sha256").update(contents).digest("hex")).toBe(artifact.sha256);
    }
    await expect(writeArtifacts(root, "run1", files, false)).rejects.toThrow(/already exists/);
    writeFileSync(path.join(directory, "notes.txt"), "keep\n");
    const replacement = files.map((file) => file.name === "summary.txt" ? { ...file, contents: "replaced\n" } : file);
    await writeArtifacts(root, "run1", replacement, true);
    expect(readFileSync(path.join(directory, "notes.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(path.join(directory, "summary.txt"), "utf8")).toBe("replaced\n");
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects unsafe ids and symbolic-link run directories, and removes temporary files after a failed write", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pratvoltix-artifacts-"));
    const files = renderBundle({ run: sampleRun(), generatedAt: "2026-10-06T00:00:00.000Z", traceRequested: false }).files;
    await expect(writeArtifacts(root, "../run1", files, false)).rejects.toThrow(/safe artifact directory/);
    expect(readdirSync(root)).toEqual([]);
    const linked = path.join(root, "linked");
    symlinkSync(root, linked);
    await expect(writeArtifacts(root, "linked", files, true)).rejects.toThrow(/symbolic link/);
    const blocked = path.join(root, "blocked");
    await mkdir(blocked);
    await mkdir(path.join(blocked, "junit.xml"));
    await expect(writeArtifacts(root, "blocked", files, true)).rejects.toThrow();
    expect(readdirSync(blocked).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect((await lstat(path.join(blocked, "junit.xml"))).isDirectory()).toBe(true);
  });
});

describe("ci commands", () => {
  it("parses ci run and artifacts export without changing the run command", async () => {
    const { parseArgs } = await import("./args.js");
    expect(parseArgs(["ci", "run", "--station", "CP001", "--suite", "smoke", "--profile", "profiles/default-ocpp16.json", "--set", "idTag=LAB", "--output", "artifacts/ocpp", "--require-trace"], {})).toMatchObject({
      kind: "ci-run",
      station: "CP001",
      suiteIds: ["smoke"],
      profilePath: "profiles/default-ocpp16.json",
      sets: [{ key: "idTag", value: "LAB" }],
      artifacts: { output: "artifacts/ocpp", requireTrace: true, noTrace: false },
    });
    expect(parseArgs(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--output", "out"], { LAB_PROFILE: "env.json" })).toMatchObject({
      profilePath: "env.json",
    });
    expect(parseArgs(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--profile", "explicit.json", "--output", "out"], { LAB_PROFILE: "env.json" })).toMatchObject({
      profilePath: "explicit.json",
    });
    expect(parseArgs(["artifacts", "export", "run1", "--output", "out", "--no-trace", "--json"], {})).toMatchObject({
      kind: "artifacts-export",
      id: "run1",
      artifacts: { noTrace: true },
    });
    expect(() => parseArgs(["artifacts", "export", "run1", "--output", "out", "--no-trace", "--require-trace"], {})).toThrow(/cannot be combined/);
    expect(() => parseArgs(["run", "--station", "CP001", "--case", "heartbeat", "--output", "out"], {})).toThrow(/only valid for ci run/);
  });

  it("covers CI exit codes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pratvoltix-ci-"));
    const passed = await runCi(root, "passed");
    expect(passed.code).toBe(0);
    expect(passed.io.out()).toContain("Exported run run1");
    expect(readFileSync(path.join(root, "run1", "junit.xml"), "utf8")).toContain('tests="1"');

    expect((await runCi(root, "failed", { overwrite: true })).code).toBe(1);
    expect((await runCi(root, "error", { overwrite: true })).code).toBe(2);

    const timeout = fakeIo(async (url) => {
      if (url.endsWith("/api/runs")) {
        return json({ ...sampleRun("running"), status: "running" });
      }
      return json({ ...sampleRun("running"), status: "running" });
    }, 0);
    expect(await executeCli(["ci", "run", "--station", "CP001", "--suite", "smoke", "--output", root, "--timeout-ms", "1", "--json"], timeout)).toBe(3);

    const offline = fakeIo(async () => {
      throw new Error("offline");
    });
    expect(await executeCli(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--output", root], offline)).toBe(6);
    expect(offline.err()).toMatch(/Cannot reach/);

    const blocked = path.join(root, "not-a-directory");
    writeFileSync(blocked, "x");
    expect(await executeCli(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--output", blocked], responding("passed"))).toBe(4);

    const missingTrace = path.join(root, "missing");
    expect(await executeCli(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--output", missingTrace, "--require-trace"], responding("passed", true))).toBe(5);
    expect(readFileSync(path.join(missingTrace, "run1", "summary.txt"), "utf8")).toContain("Trace policy failed");

    const truncated = path.join(root, "truncated");
    expect(await executeCli(["ci", "run", "--station", "CP001", "--case", "heartbeat", "--output", truncated, "--fail-on-truncated-trace"], responding("passed", false, true))).toBe(5);
    expect(readFileSync(path.join(truncated, "run1", "trace.ndjson"), "utf8").length).toBeGreaterThan(0);

    const quiet = path.join(root, "quiet");
    const noTrace = responding("passed");
    expect(await executeCli(["artifacts", "export", "run1", "--output", quiet, "--no-trace", "--json"], noTrace)).toBe(0);
    const body = JSON.parse(noTrace.out()) as { artifacts: string[]; traceSummary: null };
    expect(body.artifacts).not.toContain("trace.ndjson");
    expect(body.traceSummary).toBeNull();

    const queued = fakeIo(async () => json({ ...sampleRun("queued"), status: "queued" }));
    expect(await executeCli(["artifacts", "export", "run1", "--output", path.join(root, "queued")], queued)).toBe(6);
    expect(queued.err()).toMatch(/queued/);
  });
});

async function runCi(root: string, status: "passed" | "failed" | "error", options?: { overwrite?: boolean }) {
  const io = responding(status);
  const code = await executeCli([
    "ci",
    "run",
    "--station",
    "CP001",
    "--suite",
    "smoke",
    "--output",
    root,
    ...(options?.overwrite ? ["--overwrite"] : []),
  ], io);
  return { code, io };
}

function responding(status: "passed" | "failed" | "error" | "queued" | "running", emptyTrace = false, truncated = false): CliIo {
  return fakeIo(async (url) => {
    if (url.includes("/trace")) {
      return json(sampleTrace(emptyTrace, truncated));
    }
    return json(sampleRun(status));
  });
}

function sampleRun(status: "passed" | "failed" | "error" | "queued" | "running" = "passed") {
  const terminal = status === "passed" || status === "failed" || status === "error";
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
      cases: [{
        id: "heartbeat",
        title: "Heartbeat",
        description: "Trigger a Heartbeat.",
        version: "1.6",
        tags: ["core"],
        timeoutMs: 15000,
        origins: [{ type: "suite", id: "smoke", title: "Smoke" }],
      }],
    },
    profile: { schemaVersion: "1", name: "default-ocpp16", parameters: { idTag: "TEST-TAG-001", connectorId: 1 } },
    summary: {
      total: terminal ? 1 : 0,
      passed: status === "passed" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
      error: status === "error" ? 1 : 0,
    },
    results: terminal ? [{
      id: "heartbeat",
      title: "Heartbeat",
      status: status === "queued" || status === "running" ? "passed" : status,
      durationMs: 4,
      ...(status === "passed" ? {} : { error: "no" }),
      logs: [],
    }] : [],
    trace: { capturedEntries: 1, droppedEntries: 0, truncatedEntries: 0, truncated: false },
  };
}

function sampleTrace(empty = false, truncated = false) {
  return {
    runId: "run1",
    summary: {
      capturedEntries: empty ? 0 : 1,
      droppedEntries: truncated ? 1 : 0,
      truncatedEntries: truncated ? 1 : 0,
      truncated,
    },
    entries: empty ? [] : [{
      sequence: 1,
      at: "2026-10-06T00:00:01.000Z",
      direction: "csms-to-charge-point",
      messageType: "CALL",
      action: "Heartbeat",
      payload: {},
    }],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeIo(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now = 1_000): CliIo {
  let out = "";
  let err = "";
  let clock = now;
  return {
    fetch: (input, init) => fetchImpl(String(input), init),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    sleep: async () => {
      clock += 1_000;
    },
    now: () => clock,
    out: () => out,
    err: () => err,
  } as CliIo & { out: () => string; err: () => string };
}

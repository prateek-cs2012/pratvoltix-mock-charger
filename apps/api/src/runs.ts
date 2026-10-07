import type { OcppPeer } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { runPlan, type PlanStep, type TestCaseResult } from "@pratvoltix/test-runner";
import { defaultOcppRunProfile, storedOcppRunProfile, testCases, type EffectiveOcppRunProfile } from "@pratvoltix/test-cases";
import type { Types } from "mongoose";
import { executeExternalRun } from "./external-run.js";
import { ExternalOcppSession, type MirroredFrame } from "./external-peer.js";
import { TestRunModel, type TestRunRecord } from "./models/test-run.js";
import type { SessionRegistry } from "./ocpp/registry.js";
import type { SimulatorRegistry } from "./simulator/registry.js";
import { RunTraceCollector } from "./trace-collector.js";
import { presentTraceSummary } from "./trace-query.js";
import type { StoredTrace } from "./trace-types.js";

export interface RunTargetExecution {
  mode: "embedded" | "external";
  rawEndpoint: string;
}

export async function executeRun(
  runId: Types.ObjectId,
  registry: SessionRegistry,
  identity: string,
  simulators?: SimulatorRegistry,
  execution?: RunTargetExecution,
): Promise<void> {
  if (execution?.mode === "external") {
    await executeExternalStation(runId, identity, simulators, execution.rawEndpoint);
    return;
  }
  const session = registry.get(identity);
  if (!session) {
    await TestRunModel.findByIdAndUpdate(runId, {
      status: "error",
      startedAt: new Date(),
      finishedAt: new Date(),
      summary: { total: 0, passed: 0, failed: 0, error: 1 },
      results: [
        {
          id: "session",
          title: "Charge point session",
          status: "error",
          durationMs: 0,
          error: `${identity} disconnected before the run started`,
          logs: [],
        },
      ],
    });
    return;
  }

  await TestRunModel.findByIdAndUpdate(runId, {
    status: "running",
    startedAt: new Date(),
    "target.negotiatedSubprotocol": "ocpp1.6",
  });
  const run = await TestRunModel.findById(runId);
  if (!run) {
    return;
  }

  const needsSimulator = planRequiresSimulator(run);
  if (needsSimulator) {
    try {
      await simulators?.ensureClean(identity);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Simulator fault state is not clean";
      await TestRunModel.findByIdAndUpdate(runId, {
        status: "error",
        finishedAt: new Date(),
        summary: { total: 1, passed: 0, failed: 0, error: 1 },
        results: [
          {
            id: "simulator",
            title: "Simulator cleanup",
            status: "error",
            durationMs: 0,
            error: message,
            logs: [],
          },
        ],
      });
      return;
    }
  }

  let profile: EffectiveOcppRunProfile;
  try {
    profile = profileForRun(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored profile is invalid";
    await TestRunModel.findByIdAndUpdate(runId, {
      status: "error",
      finishedAt: new Date(),
      summary: { total: 1, passed: 0, failed: 0, error: 1 },
      results: [
        {
          id: "profile",
          title: "Run profile",
          status: "error",
          durationMs: 0,
          error: message,
          logs: [],
        },
      ],
    });
    return;
  }

  const collector = new RunTraceCollector(session.connection);
  collector.start();
  const simulator = needsSimulator ? simulators?.controller(identity) : undefined;
  const reconnectStormController = needsSimulator ? simulators?.reconnectStormController(identity) : undefined;
  const extendedSimulator = needsSimulator ? simulators?.extendedSimulatorController(identity) : undefined;
  try {
    const report = await runPlan({
      steps: planSteps(run),
      cases: testCases,
      createContext: (helpers) => ({
        ...helpers,
        peer: session.connection,
        chargePointId: identity,
        profile,
        ...(simulator ? { simulator } : {}),
        ...(reconnectStormController ? { reconnectStormController } : {}),
        ...(extendedSimulator ? { extendedSimulator } : {}),
      }),
      lifecycle: {
        onCaseStart(step) {
          collector.setActiveCase(step.id);
        },
        onCaseFinish() {
          collector.setActiveCase(undefined);
        },
      },
    });
    const summary = summarize(report.results);
    await TestRunModel.findByIdAndUpdate(runId, {
      status: report.status,
      finishedAt: new Date(report.finishedAt),
      summary,
      results: report.results,
      trace: safeSnapshot(collector),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run failed";
    await TestRunModel.findByIdAndUpdate(runId, {
      status: "error",
      finishedAt: new Date(),
      summary: { total: 1, passed: 0, failed: 0, error: 1 },
      results: [
        {
          id: "runner",
          title: "Test runner",
          status: "error",
          durationMs: 0,
          error: message,
          logs: [],
        },
      ],
      trace: safeSnapshot(collector),
    });
  } finally {
    collector.stop();
    if (needsSimulator) {
      await simulators?.finish(identity);
    }
  }
}

export function presentRun(run: TestRunRecord) {
  return {
    id: String(run._id),
    chargePointIdentity: run.chargePointIdentity,
    caseIds: run.caseIds,
    selection: run.selection
      ? {
          caseIds: [...run.selection.caseIds],
          scenarioIds: [...run.selection.scenarioIds],
          suiteIds: [...run.selection.suiteIds],
        }
      : null,
    plan: run.plan
      ? {
          catalogVersion: run.plan.catalogVersion,
          selection: {
            caseIds: [...run.plan.selection.caseIds],
            scenarioIds: [...run.plan.selection.scenarioIds],
            suiteIds: [...run.plan.selection.suiteIds],
          },
          cases: run.plan.cases.map((testCase) => ({
            id: testCase.id,
            title: testCase.title,
            description: testCase.description,
            version: testCase.version,
            tags: [...testCase.tags],
            requirements: [...(testCase.requirements ?? [])],
            ...(testCase.deployment ? { deployment: testCase.deployment } : {}),
            timeoutMs: testCase.timeoutMs,
            origins: testCase.origins.map((origin) => ({
              type: origin.type,
              id: origin.id,
              title: origin.title,
            })),
          })),
        }
      : null,
    status: run.status,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    createdAt: new Date(run.createdAt).toISOString(),
    summary: run.summary,
    results: run.results,
    trace: presentTraceSummary(run.trace),
    profile: presentProfile(run, true),
    target: presentTarget(run),
  };
}

export function presentRunList(run: TestRunRecord) {
  const presented = presentRun(run);
  return {
    ...presented,
    profile: {
      schemaVersion: presented.profile.schemaVersion,
      name: presented.profile.name,
      stored: presented.profile.stored,
    },
  };
}

async function executeExternalStation(
  runId: Types.ObjectId,
  identity: string,
  simulators: SimulatorRegistry | undefined,
  rawEndpoint: string,
): Promise<void> {
  const external = new ExternalOcppSession((action, connectorId) => {
    if (!simulators) {
      throw new Error("Simulator control is not connected.");
    }
    return simulators.emitOcpp(identity, action, connectorId);
  });
  simulators?.watchOcpp(identity, {
    onFrame: (payload) => {
      if (isMirroredFrame(payload)) {
        external.ingest(payload);
      }
    },
    onState: () => undefined,
  });
  const collector = new RunTraceCollector(external);
  collector.start();
  try {
    const outcome = await executeExternalRun({
      connect: async () => {
        if (!simulators?.get(identity)?.connected) {
          throw new Error("Simulator control is not connected.");
        }
        return simulators.connectOcpp(identity, rawEndpoint);
      },
      restore: async () => {
        collector.stop();
        simulators?.clearOcppWatch(identity);
        await simulators?.restoreBootstrap(identity);
      },
      run: async (subprotocol) => {
        await TestRunModel.findByIdAndUpdate(runId, {
          status: "running",
          startedAt: new Date(),
          "target.negotiatedSubprotocol": subprotocol,
        });
        await runStoredPlan(runId, identity, external, collector, simulators);
      },
    });
    if (!outcome.error) {
      return;
    }
    const current = await TestRunModel.findById(runId);
    if (current && current.status !== "queued" && current.status !== "running") {
      return;
    }
    await TestRunModel.findByIdAndUpdate(runId, {
      status: "error",
      startedAt: current?.startedAt ?? new Date(),
      finishedAt: new Date(),
      "target.negotiatedSubprotocol": outcome.negotiatedSubprotocol,
      summary: { total: 1, passed: 0, failed: 0, error: 1 },
      results: [
        {
          id: "target",
          title: "External CSMS",
          status: "error",
          durationMs: 0,
          error: outcome.error,
          logs: [],
        },
      ],
      trace: safeSnapshot(collector),
    });
  } finally {
    collector.stop();
    simulators?.clearOcppWatch(identity);
  }
}

async function runStoredPlan(
  runId: Types.ObjectId,
  identity: string,
  peer: OcppPeer,
  collector: RunTraceCollector,
  simulators?: SimulatorRegistry,
): Promise<void> {
  const run = await TestRunModel.findById(runId);
  if (!run) {
    return;
  }
  const needsSimulator = planRequiresSimulator(run);
  let profile: EffectiveOcppRunProfile;
  try {
    profile = profileForRun(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored profile is invalid";
    await TestRunModel.findByIdAndUpdate(runId, {
      status: "error",
      finishedAt: new Date(),
      summary: { total: 1, passed: 0, failed: 0, error: 1 },
      results: [{ id: "profile", title: "Run profile", status: "error", durationMs: 0, error: message, logs: [] }],
    });
    return;
  }
  const simulator = needsSimulator ? simulators?.controller(identity) : undefined;
  const reconnectStormController = needsSimulator ? simulators?.reconnectStormController(identity) : undefined;
  const extendedSimulator = needsSimulator ? simulators?.extendedSimulatorController(identity) : undefined;
  const report = await runPlan({
    steps: planSteps(run),
    cases: testCases,
    createContext: (helpers) => ({
      ...helpers,
      peer,
      chargePointId: identity,
      profile,
      ...(simulator ? { simulator } : {}),
      ...(reconnectStormController ? { reconnectStormController } : {}),
      ...(extendedSimulator ? { extendedSimulator } : {}),
    }),
    lifecycle: {
      onCaseStart(step) {
        collector.setActiveCase(step.id);
      },
      onCaseFinish() {
        collector.setActiveCase(undefined);
      },
    },
  });
  const summary = summarize(report.results);
  await TestRunModel.findByIdAndUpdate(runId, {
    status: report.status,
    finishedAt: new Date(report.finishedAt),
    summary,
    results: report.results,
    trace: safeSnapshot(collector),
  });
}

function isMirroredFrame(value: unknown): value is MirroredFrame {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const frame = value as { direction?: unknown; raw?: unknown };
  return (frame.direction === "charge-point-to-csms" || frame.direction === "csms-to-charge-point") && typeof frame.raw === "string";
}

function presentTarget(run: TestRunRecord) {
  const target = run.target;
  if (!target) {
    return null;
  }
  return {
    mode: target.mode,
    configurationSource: target.configurationSource,
    urlTemplate: target.urlTemplate,
    resolvedEndpoint: target.resolvedEndpoint,
    stationIdentity: target.stationIdentity,
    requestedSubprotocol: target.requestedSubprotocol,
    negotiatedSubprotocol: target.negotiatedSubprotocol ?? null,
  };
}

function safeSnapshot(collector: RunTraceCollector): StoredTrace {
  try {
    return collector.snapshot();
  } catch {
    return {
      summary: { capturedEntries: 0, droppedEntries: 0, truncatedEntries: 0, truncated: false },
      entries: [],
    };
  }
}

function profileForRun(run: TestRunRecord): EffectiveOcppRunProfile {
  if (!run.profile) {
    return defaultOcppRunProfile();
  }
  return storedOcppRunProfile(plainProfile(run.profile));
}

function presentProfile(run: TestRunRecord, detail: boolean) {
  const stored = Boolean(run.profile);
  const profile = stored ? storedOcppRunProfile(plainProfile(run.profile)) : defaultOcppRunProfile();
  return {
    schemaVersion: profile.schemaVersion,
    name: profile.name,
    stored,
    ...(detail
      ? {
          overridden: [...profile.overridden],
          parameters: { ...profile.parameters },
        }
      : {}),
  };
}

function plainProfile(profile: unknown): unknown {
  return JSON.parse(JSON.stringify(profile)) as unknown;
}

function planRequiresSimulator(run: TestRunRecord): boolean {
  return (run.plan?.cases ?? []).some((testCase) => (testCase.requirements ?? []).includes(SIMULATOR_CAPABILITY));
}

function planSteps(run: TestRunRecord): PlanStep[] {
  if (run.plan && run.plan.cases.length > 0) {
    return run.plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      timeoutMs: testCase.timeoutMs,
    }));
  }
  return run.caseIds.map((id) => ({ id }));
}

function summarize(results: TestCaseResult[]) {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    error: results.filter((result) => result.status === "error").length,
  };
}

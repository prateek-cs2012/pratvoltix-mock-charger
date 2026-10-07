import { describeCatalog, listTestCases, profileCatalog, type ExecutionPlan } from "@pratvoltix/test-cases";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { config } from "./config.js";
import { HttpError } from "./http-error.js";
import { ChargePointModel, type ChargePointRecord } from "./models/charge-point.js";
import { TestRunModel, type TestRunRecord } from "./models/test-run.js";
import type { SessionRegistry } from "./ocpp/registry.js";
import { prepareRun, storedTarget, type PrepareRunOptions } from "./run-request.js";
import { executeRun, presentRun, presentRunList } from "./runs.js";
import { SimulatorRegistry } from "./simulator/registry.js";
import { presentTrace, readTraceFilter, readTracePage } from "./trace-query.js";

export function createApp(registry: SessionRegistry, simulators: SimulatorRegistry = new SimulatorRegistry()): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "pratvoltix-api",
      database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    });
  });

  app.get("/api/settings", (_req, res) => {
    res.json({
      websocketBaseUrl: config.publicWsUrl,
      ocppVersion: "1.6",
      subprotocol: "ocpp1.6",
    });
  });

  app.get("/api/charge-points", async (_req, res) => {
    const chargePoints = await ChargePointModel.find().sort({ identity: 1 }).lean<ChargePointRecord[]>();
    res.json(chargePoints.map(presentChargePoint));
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({ ...describeCatalog(), profile: profileCatalog() });
  });

  app.get("/api/test-cases", (_req, res) => {
    res.json(listTestCases());
  });

  app.post("/api/run-plans/resolve", (req, res) => {
    res.json(previewRunPlan(req.body, registry, simulators));
  });

  app.get("/api/simulators", async (_req, res) => {
    const statuses = [];
    for (const status of simulators.list()) {
      statuses.push((await simulators.refresh(status.identity)) ?? status);
    }
    res.json(statuses);
  });

  app.get("/api/simulators/:identity", async (req, res) => {
    const identity = routeParam(req.params.identity);
    const status = await simulators.refresh(identity);
    if (!status) {
      throw new HttpError(404, `Simulator ${identity} was not found`);
    }
    res.json(status);
  });

  app.get("/api/runs", async (_req, res) => {
    const runs = await TestRunModel.find().sort({ createdAt: -1 }).limit(50).lean<TestRunRecord[]>();
    res.json(runs.map(presentRunList));
  });

  app.get("/api/runs/:id/trace", async (req, res) => {
    const id = routeParam(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      throw new HttpError(404, "Run not found");
    }
    const filter = readTraceFilter(req.query as Record<string, unknown>);
    const page = readTracePage(req.query as Record<string, unknown>);
    const run = await TestRunModel.findById(id).lean<TestRunRecord | null>();
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    const presented = presentRun(run);
    res.json(presentTrace(String(run._id), run.trace, filter, {
      schemaVersion: presented.profile.schemaVersion,
      name: presented.profile.name,
    }, page));
  });

  app.get("/api/runs/:id", async (req, res) => {
    const id = routeParam(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      throw new HttpError(404, "Run not found");
    }
    const run = await TestRunModel.findById(id).lean<TestRunRecord | null>();
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    res.json(presentRun(run));
  });

  app.post("/api/runs", async (req, res) => {
    const body = prepareFromRequest(req.body);
    if (body.target.mode === "external") {
      const simulator = simulators.get(body.chargePointIdentity);
      if (!simulator?.connected) {
        throw new HttpError(409, `Simulator control for ${body.chargePointIdentity} is not connected`);
      }
    } else if (!registry.get(body.chargePointIdentity)) {
      throw new HttpError(409, `Charge point ${body.chargePointIdentity} is not connected`);
    }
    if (!registry.tryLock(body.chargePointIdentity)) {
      throw new HttpError(409, `A run is already active for ${body.chargePointIdentity}`);
    }

    try {
      await assertStationReady(body.chargePointIdentity, body.plan, simulators);
      const created = await TestRunModel.create({
        chargePointIdentity: body.chargePointIdentity,
        caseIds: body.caseIds,
        selection: body.selection,
        plan: body.plan,
        profile: {
          schemaVersion: body.profile.schemaVersion,
          name: body.profile.name,
          overridden: [...body.profile.overridden],
          parameters: { ...body.profile.parameters },
        },
        target: storedTarget(body.target),
        status: "queued",
        summary: { total: body.caseIds.length, passed: 0, failed: 0, error: 0 },
        results: [],
      });
      void executeRun(created._id, registry, body.chargePointIdentity, simulators, {
        mode: body.target.mode,
        rawEndpoint: body.target.rawEndpoint,
      }).finally(() => {
        registry.unlock(body.chargePointIdentity);
      });
      res.status(202).json(presentRun(created.toObject() as TestRunRecord));
    } catch (error) {
      registry.unlock(body.chargePointIdentity);
      throw error;
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function prepareFromRequest(body: unknown) {
  const options: PrepareRunOptions = { defaultBaseUrl: config.publicWsUrl };
  if (config.targetCsmsUrl) {
    options.environmentUrl = config.targetCsmsUrl;
  }
  return prepareRun(body, options);
}

function previewRunPlan(body: unknown, registry: SessionRegistry, simulators: SimulatorRegistry) {
  const prepared = prepareFromRequest(body);
  const simulator = simulators.get(prepared.chargePointIdentity);
  const capabilities = simulator?.connected ? [...simulator.capabilities] : [];
  const missing = new Map<string, string[]>();
  for (const testCase of prepared.plan.cases) {
    for (const capability of testCase.requirements) {
      if (!capabilities.includes(capability)) {
        const caseIds = missing.get(capability) ?? [];
        caseIds.push(testCase.id);
        missing.set(capability, caseIds);
      }
    }
  }
  const missingCapabilities = [...missing.entries()].map(([capability, caseIds]) => ({ capability, caseIds }));
  return {
    station: {
      identity: prepared.chargePointIdentity,
      connected: Boolean(registry.get(prepared.chargePointIdentity)),
      simulatorConnected: Boolean(simulator?.connected),
      ocppVersion: "1.6",
      capabilities,
    },
    target: storedTarget(prepared.target),
    selection: prepared.selection,
    plan: {
      catalogVersion: prepared.plan.catalogVersion,
      cases: prepared.plan.cases.map((testCase) => ({
        id: testCase.id,
        title: testCase.title,
        description: testCase.description,
        version: testCase.version,
        tags: [...testCase.tags],
        requirements: [...testCase.requirements],
        deployment: testCase.deployment,
        timeoutMs: testCase.timeoutMs,
        origins: testCase.origins.map((origin) => ({ type: origin.type, id: origin.id, title: origin.title })),
      })),
    },
    effectiveProfile: {
      schemaVersion: prepared.profile.schemaVersion,
      name: prepared.profile.name,
      overridden: [...prepared.profile.overridden],
      parameters: { ...prepared.profile.parameters },
    },
    compatibility: {
      compatible: missingCapabilities.length === 0,
      missingCapabilities,
    },
    estimatedTimeoutMs: prepared.plan.cases.reduce((total, testCase) => total + testCase.timeoutMs, 0),
  };
}

function presentChargePoint(chargePoint: ChargePointRecord) {
  return {
    identity: chargePoint.identity,
    ocppVersion: chargePoint.ocppVersion,
    vendor: chargePoint.vendor ?? null,
    model: chargePoint.model ?? null,
    serialNumber: chargePoint.serialNumber ?? null,
    firmwareVersion: chargePoint.firmwareVersion ?? null,
    status: chargePoint.status,
    connectorStatus: chargePoint.connectorStatus ?? null,
    lastSeenAt: chargePoint.lastSeenAt ? new Date(chargePoint.lastSeenAt).toISOString() : null,
    lastBootAt: chargePoint.lastBootAt ? new Date(chargePoint.lastBootAt).toISOString() : null,
    heartbeatInterval: chargePoint.heartbeatInterval ?? null,
    activeTransactionId: chargePoint.activeTransactionId ?? null,
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "Missing route parameter");
  }
  return value;
}

async function assertStationReady(identity: string, plan: ExecutionPlan, simulators: SimulatorRegistry): Promise<void> {
  const required = new Map<string, string[]>();
  for (const testCase of plan.cases) {
    for (const requirement of testCase.requirements) {
      const caseIds = required.get(requirement) ?? [];
      caseIds.push(testCase.id);
      required.set(requirement, caseIds);
    }
  }
  if (required.size === 0) {
    return;
  }
  const simulator = simulators.get(identity);
  for (const [capability, caseIds] of required) {
    if (!simulator?.connected || !simulator.capabilities.includes(capability)) {
      throw new HttpError(
        409,
        `Station ${identity} is missing capability ${capability} required by cases: ${caseIds.join(", ")}`,
      );
    }
  }
  if (required.has(SIMULATOR_CAPABILITY)) {
    try {
      await simulators.ensureClean(identity);
    } catch (error) {
      const message = error instanceof Error ? error.message : "fault state cannot be confirmed clean";
      throw new HttpError(409, `Station ${identity} fault state cannot be confirmed clean: ${message}`);
    }
  }
}

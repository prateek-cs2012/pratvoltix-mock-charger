import mongoose, { Schema, type InferSchemaType } from "mongoose";

const logSchema = new Schema(
  {
    level: { type: String, required: true, enum: ["info", "error"] },
    message: { type: String, required: true },
    at: { type: String, required: true },
  },
  { _id: false },
);

const resultSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    status: { type: String, required: true, enum: ["passed", "failed", "error"] },
    durationMs: { type: Number, required: true },
    error: String,
    logs: { type: [logSchema], required: true },
  },
  { _id: false },
);

const originSchema = new Schema(
  {
    type: { type: String, required: true, enum: ["case", "scenario", "suite"] },
    id: { type: String, required: true },
    title: { type: String, required: true },
  },
  { _id: false },
);

const plannedCaseSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    version: { type: String, required: true },
    tags: { type: [String], required: true },
    requirements: { type: [String], required: false, default: [] },
    timeoutMs: { type: Number, required: true },
    deployment: { type: String, required: false },
    origins: { type: [originSchema], required: true },
  },
  { _id: false },
);

const selectionSchema = new Schema(
  {
    caseIds: { type: [String], required: true },
    scenarioIds: { type: [String], required: true },
    suiteIds: { type: [String], required: true },
  },
  { _id: false },
);

const planSchema = new Schema(
  {
    catalogVersion: { type: String, required: true },
    selection: { type: selectionSchema, required: true },
    cases: { type: [plannedCaseSchema], required: true },
  },
  { _id: false },
);

const traceSummarySchema = new Schema(
  {
    capturedEntries: { type: Number, required: true },
    droppedEntries: { type: Number, required: true },
    truncatedEntries: { type: Number, required: true },
    truncated: { type: Boolean, required: true },
  },
  { _id: false },
);

const traceEntrySchema = new Schema(
  {
    sequence: { type: Number, required: true },
    at: { type: String, required: true },
    direction: {
      type: String,
      required: true,
      enum: ["csms-to-charge-point", "charge-point-to-csms"],
    },
    messageType: {
      type: String,
      required: true,
      enum: ["CALL", "CALLRESULT", "CALLERROR", "UNKNOWN"],
    },
    uniqueId: String,
    action: String,
    payload: Schema.Types.Mixed,
    errorCode: String,
    errorDescription: String,
    raw: String,
    caseId: String,
    originalRawBytes: Number,
    originalPayloadBytes: Number,
  },
  { _id: false, minimize: false },
);

const traceSchema = new Schema(
  {
    summary: { type: traceSummarySchema, required: true },
    entries: { type: [traceEntrySchema], required: true },
  },
  { _id: false, minimize: false },
);

const profileSchema = new Schema(
  {
    schemaVersion: { type: String, required: true },
    name: { type: String, required: true },
    overridden: { type: [String], required: true },
    parameters: {
      connectorId: { type: Number, required: true },
      idTag: { type: String, required: true },
      transactionId: { type: Number, required: true },
      configurationKey: { type: String, required: true },
      configurationTestValue: { type: String, required: true },
      callTimeoutMs: { type: Number, required: true },
      eventTimeoutMs: { type: Number, required: true },
      simulatorDelayMs: { type: Number, required: true },
      simulatorTimeoutMs: { type: Number, required: true },
    },
  },
  { _id: false },
);

const targetSchema = new Schema(
  {
    mode: { type: String, required: true, enum: ["embedded", "external"] },
    configurationSource: { type: String, required: true, enum: ["run", "environment", "default"] },
    urlTemplate: { type: String, required: true },
    resolvedEndpoint: { type: String, required: true },
    stationIdentity: { type: String, required: true },
    requestedSubprotocol: { type: String, required: true },
    negotiatedSubprotocol: { type: String, required: false, default: null },
  },
  { _id: false },
);

const testRunSchema = new Schema(
  {
    chargePointIdentity: { type: String, required: true, index: true },
    caseIds: { type: [String], required: true },
    selection: { type: selectionSchema, required: false },
    plan: { type: planSchema, required: false },
    profile: { type: profileSchema, required: false },
    status: {
      type: String,
      required: true,
      enum: ["queued", "running", "passed", "failed", "error"],
      default: "queued",
    },
    startedAt: Date,
    finishedAt: Date,
    summary: {
      total: { type: Number, required: true },
      passed: { type: Number, required: true },
      failed: { type: Number, required: true },
      error: { type: Number, required: true },
    },
    results: { type: [resultSchema], required: true, default: [] },
    trace: { type: traceSchema, required: false },
    target: { type: targetSchema, required: false },
  },
  // Keep empty OCPP payloads such as Heartbeat {}. Mongoose would otherwise drop them.
  { timestamps: true, minimize: false },
);

export type TestRunRecord = InferSchemaType<typeof testRunSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const TestRunModel = mongoose.model("TestRun", testRunSchema);

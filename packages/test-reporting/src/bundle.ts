import { normalizeRun, normalizeTrace } from "./normalize.js";
import { renderJunit } from "./junit.js";
import { renderNdjson } from "./ndjson.js";
import { renderSummary } from "./summary.js";
import { byteLength, jsonText, sha256Hex } from "./text.js";
import {
  MANIFEST_SCHEMA_VERSION,
  REPORT_GENERATOR,
  type ArtifactManifest,
  type RenderedArtifact,
  type ReportRun,
  type ReportTrace,
  type ReportTraceSummary,
  type TracePolicy,
} from "./types.js";

export interface RenderInput {
  run: unknown;
  trace?: unknown;
  generatedAt: string;
  traceRequested: boolean;
  requireTrace?: boolean;
  failOnTruncatedTrace?: boolean;
  generator?: { name: string; version: string };
}

export interface RenderedBundle {
  run: ReportRun;
  trace: ReportTrace | null;
  policy: TracePolicy;
  files: RenderedArtifact[];
}

export function assessTracePolicy(summary: ReportTraceSummary, requireTrace: boolean, failOnTruncatedTrace: boolean): TracePolicy {
  const reasons: string[] = [];
  if (requireTrace && summary.capturedEntries === 0) {
    reasons.push("--require-trace: capturedEntries is 0.");
  }
  if (failOnTruncatedTrace && summary.truncated) {
    reasons.push("--fail-on-truncated-trace: truncated is true.");
  }
  const policy: TracePolicy = {
    requireTrace,
    failOnTruncatedTrace,
    passed: reasons.length === 0,
  };
  if (reasons.length > 0) {
    policy.reason = reasons.join(" ");
  }
  return policy;
}

export function renderBundle(input: RenderInput): RenderedBundle {
  const run = normalizeRun(input.run);
  const trace = input.traceRequested ? normalizeTrace(input.trace, run.id) : null;
  if (trace) {
    run.traceSummary = trace.summary;
  }
  const policy = assessTracePolicy(trace?.summary ?? run.traceSummary, input.requireTrace ?? false, input.failOnTruncatedTrace ?? false);
  const generator = input.generator ?? REPORT_GENERATOR;
  const files: RenderedArtifact[] = [
    { name: "run.json", mediaType: "application/json", contents: jsonText(run) },
    { name: "junit.xml", mediaType: "application/xml", contents: renderJunit(run) },
    { name: "summary.txt", mediaType: "text/plain", contents: renderSummary(run, trace, policy) },
  ];
  if (trace) {
    files.push(
      { name: "trace.ndjson", mediaType: "application/x-ndjson", contents: renderNdjson(trace) },
      {
        name: "trace-summary.json",
        mediaType: "application/json",
        contents: jsonText({
          runId: run.id,
          capturedEntries: trace.summary.capturedEntries,
          exportedEntries: trace.entries.length,
          droppedEntries: trace.summary.droppedEntries,
          truncatedEntries: trace.summary.truncatedEntries,
          truncated: trace.summary.truncated,
        }),
      },
    );
  }
  const manifest = manifestDocument(run, files, input.generatedAt, generator, trace ? "complete" : "not-requested", policy);
  files.push({ name: "manifest.json", mediaType: "application/json", contents: jsonText(manifest) });
  return { run, trace, policy, files };
}

function manifestDocument(
  run: ReportRun,
  files: RenderedArtifact[],
  generatedAt: string,
  generator: { name: string; version: string },
  traceExport: ArtifactManifest["traceExport"],
  policy: TracePolicy,
): ArtifactManifest {
  const artifacts = [...files]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((file) => ({
      name: file.name,
      mediaType: file.mediaType,
      bytes: byteLength(file.contents),
      sha256: sha256Hex(file.contents),
    }));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    generator,
    run: {
      id: run.id,
      station: run.chargePointIdentity,
      status: run.status,
      ...(run.plan ? { catalogVersion: run.plan.catalogVersion } : {}),
      ...(run.profile?.name ? { profileName: run.profile.name } : {}),
      ...(run.profile ? { profileSchemaVersion: run.profile.schemaVersion } : {}),
    },
    traceExport,
    ...(policy.requireTrace || policy.failOnTruncatedTrace || !policy.passed ? { tracePolicy: policy } : {}),
    artifacts,
  };
}

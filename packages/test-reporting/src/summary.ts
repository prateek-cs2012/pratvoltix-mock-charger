import { policyText } from "./junit.js";
import type { ReportRun, ReportTrace, TracePolicy } from "./types.js";

export function renderSummary(run: ReportRun, trace: ReportTrace | null, policy?: TracePolicy): string {
  const lines = [
    `Run ${run.id}`,
    `Station ${run.chargePointIdentity}`,
    `Status ${run.status}`,
    `Started ${run.startedAt ?? "unknown"}`,
    `Finished ${run.finishedAt ?? "unknown"}`,
    `Duration ${run.durationMs === undefined ? "unknown" : `${run.durationMs} ms`}`,
    `Cases ${list(run.selection?.caseIds)}`,
    `Scenarios ${list(run.selection?.scenarioIds)}`,
    `Suites ${list(run.selection?.suiteIds)}`,
    `Catalog ${run.plan?.catalogVersion ?? "unknown"}`,
    `Profile ${run.profile ? `${run.profile.name ?? "unnamed"} schema ${run.profile.schemaVersion}` : "none"}`,
    `Results passed ${run.summary.passed}, failed ${run.summary.failed}, error ${run.summary.error}`,
  ];
  if (trace) {
    lines.push(
      `Trace captured ${trace.summary.capturedEntries}, exported ${trace.entries.length}, dropped ${trace.summary.droppedEntries}, truncated entries ${trace.summary.truncatedEntries}`,
    );
    if (trace.summary.truncated) {
      lines.push("Warning: stored trace is truncated.");
    }
  } else {
    lines.push("Trace export was not requested.");
  }
  const failure = policyText(policy);
  if (failure) {
    lines.push(`Trace policy failed: ${failure}`);
  }
  lines.push("");
  for (const result of run.results) {
    lines.push(`${result.status} ${result.id} ${result.durationMs} ms ${result.title}`);
    if (result.error) {
      lines.push(`  ${result.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function list(values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return "none";
  }
  return values.join(",");
}

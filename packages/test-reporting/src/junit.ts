import type { ReportPlanCase, ReportRun, ReportTraceSummary, TracePolicy } from "./types.js";

export function renderJunit(run: ReportRun): string {
  const failures = run.results.filter((result) => result.status === "failed").length;
  const errors = run.results.filter((result) => result.status === "error").length;
  const time = formatSeconds(run.results.reduce((total, result) => total + result.durationMs, 0));
  const timestamp = run.startedAt ?? run.createdAt;
  const properties = suiteProperties(run);
  const cases = run.results.map((result) => renderCase(run, result)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeAttr(suiteName(run))}" tests="${run.results.length}" failures="${failures}" errors="${errors}" time="${time}" timestamp="${escapeAttr(timestamp)}">
  <properties>
${properties}
  </properties>
${cases}</testsuite>
`;
}

export function suiteName(run: ReportRun): string {
  const selection = run.selection;
  let label = "run";
  if (selection && selection.suiteIds.length > 0) {
    label = selection.suiteIds.join(",");
  } else if (selection && selection.scenarioIds.length > 0) {
    label = selection.scenarioIds.join(",");
  } else if (selection && selection.caseIds.length > 0) {
    label = selection.caseIds.join(",");
  } else if (!selection && !run.plan) {
    label = "historical";
  }
  return `Pratvoltix OCPP · ${run.chargePointIdentity} · ${label}`;
}

function renderCase(run: ReportRun, result: ReportRun["results"][number]): string {
  const planned = run.plan?.cases.find((item) => item.id === result.id);
  const properties = caseProperties(result.id, planned);
  const info = result.logs.filter((log) => log.level === "info");
  const errors = result.logs.filter((log) => log.level === "error");
  const body: string[] = [];
  if (properties.length > 0) {
    body.push(`    <properties>\n${properties}\n    </properties>`);
  }
  if (result.status === "failed" || result.status === "error") {
    const tag = result.status === "failed" ? "failure" : "error";
    const message = result.error ?? result.status;
    const details = [result.error ?? "", ...result.logs.map(formatLog)].filter((line) => line.length > 0).join("\n");
    body.push(`    <${tag} message="${escapeAttr(oneLine(message))}">${escapeText(details)}</${tag}>`);
  }
  if (info.length > 0) {
    body.push(`    <system-out>${escapeText(info.map(formatLog).join("\n"))}</system-out>`);
  }
  if (errors.length > 0) {
    body.push(`    <system-err>${escapeText(errors.map(formatLog).join("\n"))}</system-err>`);
  }
  const inner = body.length > 0 ? `\n${body.join("\n")}\n  ` : "";
  return `  <testcase name="${escapeAttr(result.title)}" classname="${escapeAttr(className(run, result.id))}" time="${formatSeconds(result.durationMs)}">${inner}</testcase>\n`;
}

function caseProperties(id: string, planned: ReportPlanCase | undefined): string {
  const properties: Array<[string, string]> = [["case.id", id]];
  if (planned) {
    properties.push(["case.version", planned.version]);
    if (planned.tags.length > 0) {
      properties.push(["case.tags", planned.tags.join(",")]);
    }
    if (planned.requirements && planned.requirements.length > 0) {
      properties.push(["case.requirements", planned.requirements.join(",")]);
    }
    if (planned.origins.length > 0) {
      properties.push(["case.origins", planned.origins.map((origin) => `${origin.type}:${origin.id}`).join(";")]);
    }
  }
  return properties.map(([name, value]) => `      <property name="${escapeAttr(name)}" value="${escapeAttr(value)}"/>`).join("\n");
}

function suiteProperties(run: ReportRun): string {
  const properties: Array<[string, string]> = [
    ["run.id", run.id],
    ["station.id", run.chargePointIdentity],
  ];
  if (run.plan) {
    properties.push(["catalog.version", run.plan.catalogVersion]);
  }
  if (run.profile) {
    if (run.profile.name) {
      properties.push(["profile.name", run.profile.name]);
    }
    properties.push(["profile.schemaVersion", run.profile.schemaVersion]);
  }
  if (run.selection) {
    properties.push(["selection.caseIds", run.selection.caseIds.join(",")]);
    properties.push(["selection.scenarioIds", run.selection.scenarioIds.join(",")]);
    properties.push(["selection.suiteIds", run.selection.suiteIds.join(",")]);
  }
  pushTrace(properties, run.traceSummary);
  return properties.map(([name, value]) => `    <property name="${escapeAttr(name)}" value="${escapeAttr(value)}"/>`).join("\n");
}

function pushTrace(properties: Array<[string, string]>, summary: ReportTraceSummary): void {
  properties.push(["trace.capturedEntries", String(summary.capturedEntries)]);
  properties.push(["trace.droppedEntries", String(summary.droppedEntries)]);
  properties.push(["trace.truncatedEntries", String(summary.truncatedEntries)]);
  properties.push(["trace.truncated", String(summary.truncated)]);
}

function className(run: ReportRun, caseId: string): string {
  return `pratvoltix.ocpp.${run.chargePointIdentity}.${caseId}`;
}

function formatLog(log: { at: string; message: string }): string {
  return `${log.at} ${stripUnsafe(log.message)}`;
}

export function formatSeconds(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const millis = durationMs % 1000;
  return `${seconds}.${String(millis).padStart(3, "0")}`;
}

function oneLine(value: string): string {
  return stripUnsafe(value).replace(/\s+/g, " ").trim();
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

export function escapeText(value: string): string {
  return stripUnsafe(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripUnsafe(value: string): string {
  const withoutAnsi = value.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  let cleaned = "";
  for (const char of withoutAnsi) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) {
      cleaned += char;
    }
  }
  return cleaned;
}

export function policyText(policy: TracePolicy | undefined): string | undefined {
  if (!policy || policy.passed || !policy.reason) {
    return undefined;
  }
  return policy.reason;
}

const REDACTED = "redacted";

export function externalTargetError(url: string): string | null {
  const template = url.trim();
  if (!template) {
    return "External mode requires a target URL.";
  }
  const names = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "");
  if (names.some((name) => name !== "stationId") || ((template.includes("{") || template.includes("}")) && names.length === 0)) {
    return names.some((name) => name !== "stationId") ? `Unknown target placeholder.` : "Target URL template was not fully resolved.";
  }
  const probe = names.length > 0 ? template.replaceAll("{stationId}", "CP001") : template;
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    return "Target URL is malformed.";
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return "Target URL must use ws: or wss:.";
  }
  return null;
}

export function sanitizedEndpoint(template: string, stationId: string): string | null {
  if (externalTargetError(template)) {
    return null;
  }
  const names = [...template.matchAll(/\{([^{}]+)\}/g)];
  let raw = template.trim();
  try {
    const parsed = new URL(names.length > 0 ? raw.replaceAll("{stationId}", encodeURIComponent(stationId)) : raw);
    if (names.length === 0) {
      const path = parsed.pathname.replace(/\/$/, "");
      parsed.pathname = `${path}/${encodeURIComponent(stationId)}`;
    }
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

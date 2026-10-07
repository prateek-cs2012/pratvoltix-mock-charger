export const PROFILE_SCHEMA_VERSION = "1" as const;

export const PROFILE_PARAMETER_NAMES = [
  "connectorId",
  "idTag",
  "transactionId",
  "configurationKey",
  "configurationTestValue",
  "callTimeoutMs",
  "eventTimeoutMs",
  "simulatorDelayMs",
  "simulatorTimeoutMs",
] as const;

export type ProfileParameterName = (typeof PROFILE_PARAMETER_NAMES)[number];

export interface OcppRunParameters {
  connectorId: number;
  idTag: string;
  transactionId: number;
  configurationKey: string;
  configurationTestValue: string;
  callTimeoutMs: number;
  eventTimeoutMs: number;
  simulatorDelayMs: number;
  simulatorTimeoutMs: number;
}

export interface EffectiveOcppRunProfile {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly name: string;
  readonly parameters: Readonly<OcppRunParameters>;
  readonly overridden: readonly ProfileParameterName[];
}

export interface ProfileParameterSpec {
  name: ProfileParameterName;
  type: "integer" | "string";
  description: string;
  persisted: true;
  default: number | string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface ProfileCatalog {
  schemaVersions: readonly [typeof PROFILE_SCHEMA_VERSION];
  nonSecret: true;
  notice: string;
  parameters: readonly ProfileParameterSpec[];
}

export class ProfileError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ProfileError";
    this.field = field;
  }
}

const DEFAULT_NAME = "default-ocpp16";
const MAX_NAME_LENGTH = 80;
const SIGNED_31_BIT = 2_147_483_647;

const SPECS: readonly ProfileParameterSpec[] = [
  {
    name: "connectorId",
    type: "integer",
    description: "Connector used by status and transaction calls. Zero addresses the charge point itself.",
    persisted: true,
    default: 1,
    minimum: 0,
    maximum: 1_000,
  },
  {
    name: "idTag",
    type: "string",
    description: "Fake test ID tag. OCPP 1.6 idTag values are limited to 20 characters. Do not use a customer RFID.",
    persisted: true,
    default: "TEST-TAG-001",
    maxLength: 20,
  },
  {
    name: "transactionId",
    type: "integer",
    description: "CSMS-assigned transaction id returned to StartTransaction. Positive signed 32-bit integer.",
    persisted: true,
    default: 1001,
    minimum: 1,
    maximum: SIGNED_31_BIT,
  },
  {
    name: "configurationKey",
    type: "string",
    description: "Configuration key read and temporarily changed. OCPP 1.6 keys are often limited to 50 characters by the charger; the lab accepts up to 100.",
    persisted: true,
    default: "HeartbeatInterval",
    maxLength: 100,
  },
  {
    name: "configurationTestValue",
    type: "string",
    description: "Temporary configuration value. The case restores the charger's original value afterward.",
    persisted: true,
    default: "45",
    maxLength: 500,
  },
  {
    name: "callTimeoutMs",
    type: "integer",
    description: "Timeout for an OCPP call sent by a case.",
    persisted: true,
    default: 10_000,
    minimum: 100,
    maximum: 120_000,
  },
  {
    name: "eventTimeoutMs",
    type: "integer",
    description: "Timeout for waiting for an OCPP call from the charge point.",
    persisted: true,
    default: 15_000,
    minimum: 100,
    maximum: 120_000,
  },
  {
    name: "simulatorDelayMs",
    type: "integer",
    description: "One-shot delay armed by simulator-negative cases. 300ms leaves room for container timer jitter.",
    persisted: true,
    default: 300,
    minimum: 0,
    maximum: 30_000,
  },
  {
    name: "simulatorTimeoutMs",
    type: "integer",
    description: "Short call timeout used to observe a suppressed response. 500ms is long enough to time out and still finish inside the case budget.",
    persisted: true,
    default: 500,
    minimum: 100,
    maximum: 30_000,
  },
];

const SPEC_BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]));

const DEFAULT_PARAMETERS: OcppRunParameters = {
  connectorId: 1,
  idTag: "TEST-TAG-001",
  transactionId: 1001,
  configurationKey: "HeartbeatInterval",
  configurationTestValue: "45",
  callTimeoutMs: 10_000,
  eventTimeoutMs: 15_000,
  simulatorDelayMs: 300,
  simulatorTimeoutMs: 500,
};

const NOTICE =
  "Profile fields are non-secret test inputs and are persisted with the run. Do not store passwords, API keys, private keys, payment data, or personal data.";

export function profileCatalog(): ProfileCatalog {
  return {
    schemaVersions: [PROFILE_SCHEMA_VERSION],
    nonSecret: true,
    notice: NOTICE,
    parameters: SPECS.map((spec) => ({ ...spec })),
  };
}

export function defaultOcppRunProfile(): EffectiveOcppRunProfile {
  return freezeProfile({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: DEFAULT_NAME,
    parameters: cloneParameters(DEFAULT_PARAMETERS),
    overridden: [],
  });
}

export function resolveOcppRunProfile(input: { profile?: unknown; overrides?: unknown } = {}): EffectiveOcppRunProfile {
  const parameters = cloneParameters(DEFAULT_PARAMETERS);
  const explicit = new Set<ProfileParameterName>();
  let name = DEFAULT_NAME;

  if (input.profile !== undefined) {
    const profile = readProfileDocument(input.profile);
    if (profile.name !== undefined) {
      name = profile.name;
    }
    for (const key of PROFILE_PARAMETER_NAMES) {
      if (Object.prototype.hasOwnProperty.call(profile.parameters, key)) {
        parameters[key] = profile.parameters[key] as never;
        explicit.add(key);
      }
    }
  }

  if (input.overrides !== undefined) {
    const overrides = readOverrides(input.overrides);
    for (const key of PROFILE_PARAMETER_NAMES) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        parameters[key] = overrides[key] as never;
        explicit.add(key);
      }
    }
  }

  return freezeProfile({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name,
    parameters,
    overridden: PROFILE_PARAMETER_NAMES.filter((key) => explicit.has(key)),
  });
}

export function storedOcppRunProfile(value: unknown): EffectiveOcppRunProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError("Profile must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const supplied = Array.isArray(record.overridden) ? record.overridden : [];
  const profile = readProfileDocument({
    schemaVersion: record.schemaVersion,
    ...(record.name === undefined ? {} : { name: record.name }),
    parameters: record.parameters,
  });
  const parameters = {} as OcppRunParameters;
  for (const key of PROFILE_PARAMETER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(profile.parameters, key)) {
      throw new ProfileError(`Stored profile is missing ${key}.`, key);
    }
    parameters[key] = profile.parameters[key] as never;
  }
  const overridden = PROFILE_PARAMETER_NAMES.filter((key) => supplied.includes(key));
  return freezeProfile({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: profile.name ?? DEFAULT_NAME,
    parameters,
    overridden,
  });
}

export function parseProfileOverride(key: string, raw: string): { key: ProfileParameterName; value: number | string } {
  const spec = specFor(key);
  if (spec.type === "integer") {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new ProfileError(`${key} must be a base-10 integer without leading zeros. Received "${preview(raw)}".`, key);
    }
    const value = Number(raw);
    validateParameter(key, value);
    return { key: spec.name, value };
  }
  validateParameter(key, raw);
  return { key: spec.name, value: raw };
}

function readProfileDocument(value: unknown): { name?: string; parameters: Partial<OcppRunParameters> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError("Profile must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "name" && key !== "parameters") {
      throw new ProfileError(`Unknown profile field "${key}".`, key);
    }
  }
  if (record.schemaVersion === undefined) {
    throw new ProfileError('Profile schemaVersion is required. Supported version is "1".', "schemaVersion");
  }
  if (record.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileError(
      `Unsupported profile schemaVersion "${preview(record.schemaVersion)}". Supported version is "1".`,
      "schemaVersion",
    );
  }
  let name: string | undefined;
  if (record.name !== undefined) {
    if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.length > MAX_NAME_LENGTH) {
      throw new ProfileError(`Profile name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`, "name");
    }
    name = record.name;
  }
  if (record.parameters === undefined) {
    throw new ProfileError("Profile parameters are required.", "parameters");
  }
  return { ...(name === undefined ? {} : { name }), parameters: readPartialParameters(record.parameters, "profile") };
}

function readOverrides(value: unknown): Partial<OcppRunParameters> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError("Profile overrides must be a JSON object.", "overrides");
  }
  return readPartialParameters(value, "override");
}

function readPartialParameters(value: unknown, source: "profile" | "override"): Partial<OcppRunParameters> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError(
      source === "profile" ? "Profile parameters must be a JSON object." : "Profile overrides must be a JSON object.",
      source === "profile" ? "parameters" : "overrides",
    );
  }
  const record = value as Record<string, unknown>;
  const parameters: Partial<OcppRunParameters> = {};
  for (const key of Object.keys(record)) {
    specFor(key);
    const validated = validateParameter(key, record[key]);
    parameters[key as ProfileParameterName] = validated as never;
  }
  return parameters;
}

function specFor(key: string): ProfileParameterSpec {
  const spec = SPEC_BY_NAME.get(key as ProfileParameterName);
  if (!spec) {
    throw new ProfileError(`Unknown profile parameter "${key}".`, key);
  }
  return spec;
}

function validateParameter(key: string, value: unknown): number | string {
  const spec = specFor(key);
  if (spec.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ProfileError(
        `${key} must be an integer from ${spec.minimum} to ${spec.maximum}. Received ${preview(value)}.`,
        key,
      );
    }
    if (value < (spec.minimum ?? 0) || value > (spec.maximum ?? 0)) {
      throw new ProfileError(
        `${key} must be an integer from ${spec.minimum} to ${spec.maximum}. Received ${value}.`,
        key,
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new ProfileError(`${key} must be a non-empty string of at most ${spec.maxLength} characters. Received ${preview(value)}.`, key);
  }
  if (value.trim().length === 0 || value.length > (spec.maxLength ?? 0)) {
    throw new ProfileError(
      `${key} must be a non-empty string of at most ${spec.maxLength} characters. Received ${preview(value)}.`,
      key,
    );
  }
  return value;
}

function cloneParameters(parameters: OcppRunParameters): OcppRunParameters {
  const clone = {} as OcppRunParameters;
  for (const key of PROFILE_PARAMETER_NAMES) {
    clone[key] = parameters[key] as never;
  }
  return clone;
}

function freezeProfile(profile: {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  parameters: OcppRunParameters;
  overridden: readonly ProfileParameterName[];
}): EffectiveOcppRunProfile {
  const parameters = cloneParameters(profile.parameters);
  const overridden = [...profile.overridden];
  Object.freeze(parameters);
  Object.freeze(overridden);
  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    name: profile.name,
    parameters,
    overridden,
  });
}

function preview(value: unknown): string {
  if (typeof value === "string") {
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    return `"${shown}"`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return typeof value;
}

import type { ProtocolVersion, TestCase, TestContext } from "@pratvoltix/test-runner";

export const SUPPORTED_PROTOCOL_VERSIONS = ["1.6", "2.0.1"] as const;
const DEFAULT_TIMEOUT_MS = 20_000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CatalogError extends Error {
  readonly definitionType: "case" | "scenario" | "suite" | "selection" | "catalog";
  readonly definitionId: string | undefined;

  constructor(
    message: string,
    definitionType: CatalogError["definitionType"],
    definitionId?: string,
  ) {
    super(message);
    this.name = "CatalogError";
    this.definitionType = definitionType;
    this.definitionId = definitionId;
  }
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: readonly string[];
  requirements?: readonly string[];
  caseIds: readonly string[];
}

export interface SuiteDefinition {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: readonly string[];
  requirements?: readonly string[];
  caseIds?: readonly string[];
  scenarioIds?: readonly string[];
  includeTags?: readonly string[];
  excludeTags?: readonly string[];
}

export interface CatalogSelection {
  caseIds?: readonly string[];
  scenarioIds?: readonly string[];
  suiteIds?: readonly string[];
}

export interface PlanOrigin {
  type: "case" | "scenario" | "suite";
  id: string;
  title: string;
}

export interface PlannedCase {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: string[];
  requirements: string[];
  deployment: "external-compatible" | "embedded-only" | "adapter-required";
  timeoutMs: number;
  origins: PlanOrigin[];
}

export interface ExecutionPlan {
  catalogVersion: string;
  selection: {
    caseIds: string[];
    scenarioIds: string[];
    suiteIds: string[];
  };
  cases: PlannedCase[];
}

export interface TestCaseSummary {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: string[];
  requirements: string[];
  deployment: "external-compatible" | "embedded-only" | "adapter-required";
  timeoutMs: number;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: string[];
  requirements: string[];
  caseIds: string[];
}

export interface SuiteSummary {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: string[];
  requirements: string[];
  caseIds: string[];
  scenarioIds: string[];
  includeTags: string[];
  excludeTags: string[];
}

export interface CatalogDocument {
  version: string;
  cases: TestCaseSummary[];
  scenarios: ScenarioSummary[];
  suites: SuiteSummary[];
}

export interface Catalog<TContext extends TestContext = TestContext> {
  readonly version: string;
  readonly cases: readonly TestCase<TContext>[];
  readonly scenarios: readonly ScenarioDefinition[];
  readonly suites: readonly SuiteDefinition[];
  listCases(): TestCaseSummary[];
  listScenarios(): ScenarioSummary[];
  listSuites(): SuiteSummary[];
  describe(): CatalogDocument;
  resolve(selection: CatalogSelection): ExecutionPlan;
}

export function defineTestCase<TContext extends TestContext>(input: TestCase<TContext>): TestCase<TContext> {
  validateIdentity(input.id, "case");
  validateText(input.title, "case", input.id, "title");
  validateText(input.description, "case", input.id, "description");
  validateVersion(input.version, "case", input.id);
  validateTags(input.tags, "case", input.id);
  validateRequirements(input.requirements, "case", input.id);
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new CatalogError(`Case "${input.id}" timeoutMs must be a positive number.`, "case", input.id);
  }
  if (typeof input.run !== "function") {
    throw new CatalogError(`Case "${input.id}" is missing a run function.`, "case", input.id);
  }
  const deployment = input.deployment ?? "embedded-only";
  if (deployment !== "external-compatible" && deployment !== "embedded-only" && deployment !== "adapter-required") {
    throw new CatalogError(`Case "${input.id}" has an unknown deployment class.`, "case", input.id);
  }
  return {
    ...input,
    tags: [...input.tags],
    requirements: [...(input.requirements ?? [])],
    deployment,
  };
}

export function defineScenario(input: ScenarioDefinition): ScenarioDefinition {
  validateIdentity(input.id, "scenario");
  validateText(input.title, "scenario", input.id, "title");
  validateText(input.description, "scenario", input.id, "description");
  validateVersion(input.version, "scenario", input.id);
  validateTags(input.tags, "scenario", input.id);
  validateRequirements(input.requirements, "scenario", input.id);
  if (!Array.isArray(input.caseIds) || input.caseIds.length === 0) {
    throw new CatalogError(`Scenario "${input.id}" does not reference any cases.`, "scenario", input.id);
  }
  assertUniqueReferences(input.caseIds, "scenario", input.id, "case");
  return {
    ...input,
    tags: [...input.tags],
    requirements: [...(input.requirements ?? [])],
    caseIds: [...input.caseIds],
  };
}

export function defineSuite(input: SuiteDefinition): SuiteDefinition {
  validateIdentity(input.id, "suite");
  validateText(input.title, "suite", input.id, "title");
  validateText(input.description, "suite", input.id, "description");
  validateVersion(input.version, "suite", input.id);
  validateTags(input.tags, "suite", input.id);
  validateRequirements(input.requirements, "suite", input.id);
  const caseIds = input.caseIds ?? [];
  const scenarioIds = input.scenarioIds ?? [];
  const includeTags = input.includeTags ?? [];
  const excludeTags = input.excludeTags ?? [];
  if (caseIds.length === 0 && scenarioIds.length === 0 && includeTags.length === 0) {
    throw new CatalogError(
      `Suite "${input.id}" has no case ids, scenario ids, or include tags.`,
      "suite",
      input.id,
    );
  }
  assertUniqueReferences(caseIds, "suite", input.id, "case");
  assertUniqueReferences(scenarioIds, "suite", input.id, "scenario");
  validateTags(includeTags, "suite", input.id);
  validateTags(excludeTags, "suite", input.id);
  return {
    ...input,
    tags: [...input.tags],
    requirements: [...(input.requirements ?? [])],
    caseIds: [...caseIds],
    scenarioIds: [...scenarioIds],
    includeTags: [...includeTags],
    excludeTags: [...excludeTags],
  };
}

export function createCatalog<TContext extends TestContext>(input: {
  version: string;
  cases: readonly TestCase<TContext>[];
  scenarios: readonly ScenarioDefinition[];
  suites: readonly SuiteDefinition[];
}): Catalog<TContext> {
  if (typeof input.version !== "string" || input.version.trim().length === 0) {
    throw new CatalogError("Catalog version must be a non-empty string.", "catalog");
  }

  const cases = [...input.cases];
  const scenarios = [...input.scenarios];
  const suites = [...input.suites];
  const casesById = indexById(cases, "case");
  const scenariosById = indexById(scenarios, "scenario");
  const suitesById = indexById(suites, "suite");

  for (const scenario of scenarios) {
    for (const caseId of scenario.caseIds) {
      const testCase = requireCase(casesById, scenariosById, suitesById, caseId, "scenario", scenario.id);
      assertSameVersion("scenario", scenario.id, scenario.version, testCase);
    }
    assertRequirementsCovered(
      "scenario",
      scenario.id,
      scenario.requirements,
      scenario.caseIds.map((caseId) => requireCase(casesById, scenariosById, suitesById, caseId, "scenario", scenario.id)),
    );
  }

  for (const suite of suites) {
    const expanded = expandSuite(suite, cases, casesById, scenariosById, suitesById);
    if (expanded.length === 0) {
      throw new CatalogError(`Suite "${suite.id}" resolves to no cases.`, "suite", suite.id);
    }
    for (const entry of expanded) {
      assertSameVersion("suite", suite.id, suite.version, entry.testCase);
    }
    assertRequirementsCovered(
      "suite",
      suite.id,
      suite.requirements,
      expanded.map((entry) => entry.testCase),
    );
  }

  return {
    version: input.version,
    cases,
    scenarios,
    suites,
    listCases: () => cases.map(summarizeCase),
    listScenarios: () => scenarios.map(summarizeScenario),
    listSuites: () => suites.map(summarizeSuite),
    describe() {
      return {
        version: input.version,
        cases: cases.map(summarizeCase),
        scenarios: scenarios.map(summarizeScenario),
        suites: suites.map(summarizeSuite),
      };
    },
    resolve(selection) {
      return resolveSelection(input.version, selection, cases, casesById, scenariosById, suitesById);
    },
  };
}

function resolveSelection<TContext extends TestContext>(
  catalogVersion: string,
  selection: CatalogSelection,
  cases: readonly TestCase<TContext>[],
  casesById: Map<string, TestCase<TContext>>,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
): ExecutionPlan {
  const requestedCases = normalizeIdList(selection.caseIds, "caseIds");
  const requestedScenarios = normalizeIdList(selection.scenarioIds, "scenarioIds");
  const requestedSuites = normalizeIdList(selection.suiteIds, "suiteIds");
  if (requestedCases.length + requestedScenarios.length + requestedSuites.length === 0) {
    throw new CatalogError(
      "Selection is empty. Provide at least one case, scenario, or suite id.",
      "selection",
    );
  }

  const planned: PlannedCase[] = [];
  const plannedById = new Map<string, PlannedCase>();
  const add = (testCase: TestCase<TContext>, origin: PlanOrigin) => {
    const existing = plannedById.get(testCase.id);
    if (!existing) {
      const entry: PlannedCase = {
        id: testCase.id,
        title: testCase.title,
        description: testCase.description,
        version: testCase.version,
        tags: [...testCase.tags],
        requirements: [...(testCase.requirements ?? [])],
        deployment: testCase.deployment ?? "embedded-only",
        timeoutMs: testCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        origins: [origin],
      };
      planned.push(entry);
      plannedById.set(testCase.id, entry);
      return;
    }
    if (!existing.origins.some((entry) => entry.type === origin.type && entry.id === origin.id)) {
      existing.origins.push(origin);
    }
  };

  for (const suiteId of requestedSuites) {
    const suite = requireSuite(suiteId, casesById, scenariosById, suitesById);
    for (const entry of expandSuite(suite, cases, casesById, scenariosById, suitesById)) {
      add(entry.testCase, { type: "suite", id: suite.id, title: suite.title });
      if (entry.scenario) {
        add(entry.testCase, { type: "scenario", id: entry.scenario.id, title: entry.scenario.title });
      }
    }
  }

  for (const scenarioId of requestedScenarios) {
    const scenario = requireScenario(scenarioId, casesById, scenariosById, suitesById);
    for (const caseId of scenario.caseIds) {
      const testCase = requireCase(casesById, scenariosById, suitesById, caseId, "scenario", scenario.id);
      add(testCase, { type: "scenario", id: scenario.id, title: scenario.title });
    }
  }

  for (const caseId of requestedCases) {
    const testCase = requireCase(casesById, scenariosById, suitesById, caseId, "selection", caseId);
    add(testCase, { type: "case", id: testCase.id, title: testCase.title });
  }

  if (planned.length === 0) {
    throw new CatalogError("Selection resolves to no cases.", "selection");
  }

  return {
    catalogVersion,
    selection: {
      caseIds: requestedCases,
      scenarioIds: requestedScenarios,
      suiteIds: requestedSuites,
    },
    cases: planned,
  };
}

interface ExpandedCase<TContext extends TestContext> {
  testCase: TestCase<TContext>;
  scenario?: ScenarioDefinition;
}

function expandSuite<TContext extends TestContext>(
  suite: SuiteDefinition,
  cases: readonly TestCase<TContext>[],
  casesById: Map<string, TestCase<TContext>>,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
): ExpandedCase<TContext>[] {
  const expanded: ExpandedCase<TContext>[] = [];
  const push = (testCase: TestCase<TContext>, scenario?: ScenarioDefinition) => {
    if ((suite.excludeTags ?? []).some((tag) => testCase.tags.includes(tag))) {
      return;
    }
    expanded.push(scenario ? { testCase, scenario } : { testCase });
  };

  for (const caseId of suite.caseIds ?? []) {
    push(requireCase(casesById, scenariosById, suitesById, caseId, "suite", suite.id));
  }
  for (const scenarioId of suite.scenarioIds ?? []) {
    const scenario = requireScenario(scenarioId, casesById, scenariosById, suitesById, suite);
    for (const caseId of scenario.caseIds) {
      push(requireCase(casesById, scenariosById, suitesById, caseId, "scenario", scenario.id), scenario);
    }
  }
  if ((suite.includeTags ?? []).length > 0) {
    for (const testCase of cases) {
      if (testCase.tags.some((tag) => suite.includeTags?.includes(tag))) {
        push(testCase);
      }
    }
  }
  return expanded;
}

function requireCase<TContext extends TestContext>(
  casesById: Map<string, TestCase<TContext>>,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
  caseId: string,
  ownerType: "scenario" | "suite" | "selection",
  ownerId: string,
): TestCase<TContext> {
  const testCase = casesById.get(caseId);
  if (testCase) {
    return testCase;
  }
  const hint = alternateHint(caseId, scenariosById, suitesById, casesById);
  if (ownerType === "selection") {
    throw new CatalogError(`Case "${caseId}" was not found.${hint}`, "selection", caseId);
  }
  const ownerLabel = ownerType === "scenario" ? "Scenario" : "Suite";
  throw new CatalogError(
    `${ownerLabel} "${ownerId}" references missing case "${caseId}".${hint}`,
    ownerType,
    ownerId,
  );
}

function requireScenario(
  scenarioId: string,
  casesById: Map<string, TestCase>,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
  suite?: SuiteDefinition,
): ScenarioDefinition {
  const scenario = scenariosById.get(scenarioId);
  if (scenario) {
    return scenario;
  }
  const hint = alternateHint(scenarioId, scenariosById, suitesById, casesById);
  if (suite) {
    const nested = suitesById.has(scenarioId)
      ? ` Suites cannot contain other suites.`
      : "";
    throw new CatalogError(
      `Suite "${suite.id}" references missing scenario "${scenarioId}".${nested}${hint}`,
      "suite",
      suite.id,
    );
  }
  throw new CatalogError(`Scenario "${scenarioId}" was not found.${hint}`, "selection", scenarioId);
}

function requireSuite(
  suiteId: string,
  casesById: Map<string, TestCase>,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
): SuiteDefinition {
  const suite = suitesById.get(suiteId);
  if (suite) {
    return suite;
  }
  const hint = alternateHint(suiteId, scenariosById, suitesById, casesById);
  throw new CatalogError(`Suite "${suiteId}" was not found.${hint}`, "selection", suiteId);
}

function alternateHint(
  id: string,
  scenariosById: Map<string, ScenarioDefinition>,
  suitesById: Map<string, SuiteDefinition>,
  casesById: Map<string, TestCase>,
): string {
  if (casesById.has(id)) {
    return ` A case with that id exists; pass it as a case id.`;
  }
  if (scenariosById.has(id)) {
    return ` A scenario with that id exists; pass it as a scenario id.`;
  }
  if (suitesById.has(id)) {
    return ` A suite with that id exists; pass it as a suite id.`;
  }
  return "";
}

function summarizeCase(testCase: TestCase): TestCaseSummary {
  return {
    id: testCase.id,
    title: testCase.title,
    description: testCase.description,
    version: testCase.version,
    tags: [...testCase.tags],
    requirements: [...(testCase.requirements ?? [])],
    deployment: testCase.deployment ?? "embedded-only",
    timeoutMs: testCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function summarizeScenario(scenario: ScenarioDefinition): ScenarioSummary {
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    version: scenario.version,
    tags: [...scenario.tags],
    requirements: [...(scenario.requirements ?? [])],
    caseIds: [...scenario.caseIds],
  };
}

function summarizeSuite(suite: SuiteDefinition): SuiteSummary {
  return {
    id: suite.id,
    title: suite.title,
    description: suite.description,
    version: suite.version,
    tags: [...suite.tags],
    requirements: [...(suite.requirements ?? [])],
    caseIds: [...(suite.caseIds ?? [])],
    scenarioIds: [...(suite.scenarioIds ?? [])],
    includeTags: [...(suite.includeTags ?? [])],
    excludeTags: [...(suite.excludeTags ?? [])],
  };
}

function indexById<T extends { id: string }>(
  items: readonly T[],
  definitionType: "case" | "scenario" | "suite",
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) {
      throw new CatalogError(`Duplicate ${definitionType} id "${item.id}".`, definitionType, item.id);
    }
    map.set(item.id, item);
  }
  return map;
}

function assertSameVersion(
  ownerType: "scenario" | "suite",
  ownerId: string,
  ownerVersion: ProtocolVersion,
  testCase: TestCase,
): void {
  if (testCase.version !== ownerVersion) {
    const label = ownerType === "scenario" ? "Scenario" : "Suite";
    throw new CatalogError(
      `${label} "${ownerId}" includes case "${testCase.id}" with protocol version "${testCase.version}", which does not match ${ownerType} version "${ownerVersion}".`,
      ownerType,
      ownerId,
    );
  }
}

function assertUniqueReferences(
  ids: readonly string[],
  ownerType: "scenario" | "suite",
  ownerId: string,
  referenceType: "case" | "scenario",
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      throw new CatalogError(`${ownerType} "${ownerId}" contains an empty ${referenceType} id.`, ownerType, ownerId);
    }
    if (seen.has(id)) {
      throw new CatalogError(
        `${ownerType === "scenario" ? "Scenario" : "Suite"} "${ownerId}" lists ${referenceType} "${id}" more than once.`,
        ownerType,
        ownerId,
      );
    }
    seen.add(id);
  }
}

function normalizeIdList(ids: readonly string[] | undefined, field: string): string[] {
  if (ids === undefined) {
    return [];
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new CatalogError(`${field} must be an array of non-empty strings.`, "selection");
  }
  return [...new Set(ids)];
}

function validateIdentity(id: string, definitionType: "case" | "scenario" | "suite"): void {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new CatalogError(
      `${label(definitionType)} id "${String(id)}" must be lowercase words separated by hyphens.`,
      definitionType,
      typeof id === "string" ? id : undefined,
    );
  }
}

function validateText(
  value: string,
  definitionType: "case" | "scenario" | "suite",
  id: string,
  field: "title" | "description",
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError(`${label(definitionType)} "${id}" is missing a ${field}.`, definitionType, id);
  }
}

function validateVersion(
  version: string,
  definitionType: "case" | "scenario" | "suite",
  id: string,
): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
    throw new CatalogError(
      `${label(definitionType)} "${id}" has unsupported protocol version "${String(version)}".`,
      definitionType,
      id,
    );
  }
}

function validateRequirements(
  requirements: readonly string[] | undefined,
  definitionType: "case" | "scenario" | "suite",
  id: string,
): void {
  if (requirements === undefined) {
    return;
  }
  if (!Array.isArray(requirements)) {
    throw new CatalogError(`${label(definitionType)} "${id}" requirements must be an array.`, definitionType, id);
  }
  for (const requirement of requirements) {
    if (typeof requirement !== "string" || !ID_PATTERN.test(requirement)) {
      throw new CatalogError(
        `${label(definitionType)} "${id}" has invalid requirement "${String(requirement)}".`,
        definitionType,
        id,
      );
    }
  }
}

function assertRequirementsCovered(
  ownerType: "scenario" | "suite",
  ownerId: string,
  declared: readonly string[] | undefined,
  cases: readonly TestCase[],
): void {
  const covered = new Set(declared ?? []);
  const missing: string[] = [];
  for (const testCase of cases) {
    for (const requirement of testCase.requirements ?? []) {
      if (!covered.has(requirement)) {
        missing.push(`${testCase.id} requires ${requirement}`);
      }
    }
  }
  if (missing.length > 0) {
    const ownerLabel = ownerType === "scenario" ? "Scenario" : "Suite";
    throw new CatalogError(
      `${ownerLabel} "${ownerId}" does not declare requirements used by its cases: ${missing.join("; ")}.`,
      ownerType,
      ownerId,
    );
  }
}

function validateTags(
  tags: readonly string[],
  definitionType: "case" | "scenario" | "suite",
  id: string,
): void {
  if (!Array.isArray(tags)) {
    throw new CatalogError(`${label(definitionType)} "${id}" tags must be an array.`, definitionType, id);
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || !ID_PATTERN.test(tag)) {
      throw new CatalogError(
        `${label(definitionType)} "${id}" has invalid tag "${String(tag)}".`,
        definitionType,
        id,
      );
    }
  }
}

function label(definitionType: "case" | "scenario" | "suite"): string {
  if (definitionType === "case") {
    return "Case";
  }
  if (definitionType === "scenario") {
    return "Scenario";
  }
  return "Suite";
}

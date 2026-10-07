export type ProtocolVersion = "1.6" | "2.0.1";

export interface TestLog {
  level: "info" | "error";
  message: string;
  at: string;
}

export interface TestContext {
  log(message: string): void;
  readonly signal: AbortSignal;
}

export interface TestCase<TContext extends TestContext = TestContext> {
  id: string;
  title: string;
  description: string;
  version: ProtocolVersion;
  tags: readonly string[];
  /** Opaque capability names. The runner does not interpret them. */
  requirements?: readonly string[];
  deployment?: "external-compatible" | "embedded-only" | "adapter-required";
  timeoutMs?: number;
  run(ctx: TContext): Promise<void>;
}

export interface TestCaseResult {
  id: string;
  title: string;
  status: "passed" | "failed" | "error";
  durationMs: number;
  error?: string;
  logs: TestLog[];
}

export interface RunReport {
  status: "passed" | "failed" | "error";
  startedAt: string;
  finishedAt: string;
  results: TestCaseResult[];
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export class TestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestTimeoutError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      message ?? `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new AssertionError(message);
  }
}

export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PlanStep {
  id: string;
  title?: string;
  timeoutMs?: number;
}

export interface RunLifecycle {
  onCaseStart?(step: PlanStep): void | Promise<void>;
  onCaseFinish?(step: PlanStep, result: TestCaseResult): void | Promise<void>;
}

export interface RunPlanOptions<TContext extends TestContext> {
  steps: readonly PlanStep[];
  cases: readonly TestCase<TContext>[];
  createContext: (helpers: TestContext, testCase: TestCase<TContext>) => TContext | Promise<TContext>;
  /** Optional hooks. Failures are isolated so the case result is still reported. */
  lifecycle?: RunLifecycle;
}

export interface RunCasesOptions<TContext extends TestContext> {
  cases: readonly TestCase<TContext>[];
  ids: readonly string[];
  createContext: RunPlanOptions<TContext>["createContext"];
}

const DEFAULT_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TestTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function overallStatus(results: TestCaseResult[]): RunReport["status"] {
  if (results.some((result) => result.status === "error")) {
    return "error";
  }
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }
  return "passed";
}

export async function runCases<TContext extends TestContext>(
  options: RunCasesOptions<TContext>,
): Promise<RunReport> {
  const byId = new Map(options.cases.map((testCase) => [testCase.id, testCase]));
  const selectedIds = [...new Set(options.ids)];
  const steps: PlanStep[] = [
    ...options.cases.filter((testCase) => selectedIds.includes(testCase.id)).map((testCase) => ({ id: testCase.id })),
    ...selectedIds.filter((id) => !byId.has(id)).map((id) => ({ id })),
  ];
  return runPlan({
    steps,
    cases: options.cases,
    createContext: options.createContext,
  });
}

/** Executes an already resolved plan. Steps run in the given order. */
export async function runPlan<TContext extends TestContext>(options: RunPlanOptions<TContext>): Promise<RunReport> {
  const startedAt = new Date();
  const byId = new Map(options.cases.map((testCase) => [testCase.id, testCase]));
  const results: TestCaseResult[] = [];

  for (const step of options.steps) {
    await invokeLifecycle(options.lifecycle?.onCaseStart, step);
    const testCase = byId.get(step.id);
    const result = testCase
      ? await runOne(testCase, options.createContext, step)
      : unknownCaseResult(step);
    results.push(result);
    await invokeLifecycle(options.lifecycle?.onCaseFinish, step, result);
  }

  return {
    status: overallStatus(results),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    results,
  };
}

function unknownCaseResult(step: PlanStep): TestCaseResult {
  return {
    id: step.id,
    title: step.title ?? step.id,
    status: "error",
    durationMs: 0,
    error: `Unknown test case ${step.id}`,
    logs: [],
  };
}

/** Hook failures must not hide the case result or skip the rest of the plan. */
async function invokeLifecycle(
  hook: ((step: PlanStep, result: TestCaseResult) => void | Promise<void>) | undefined,
  step: PlanStep,
  result?: TestCaseResult,
): Promise<void> {
  if (!hook) {
    return;
  }
  try {
    await hook(step, result as TestCaseResult);
  } catch {
    // The case result is recorded by the caller whether or not this hook succeeds.
  }
}

async function runOne<TContext extends TestContext>(
  testCase: TestCase<TContext>,
  createContext: RunPlanOptions<TContext>["createContext"],
  step: PlanStep,
): Promise<TestCaseResult> {
  const logs: TestLog[] = [];
  const log = (level: TestLog["level"], message: string) => {
    logs.push({ level, message, at: new Date().toISOString() });
  };
  const title = step.title ?? testCase.title;
  const timeoutMs = step.timeoutMs ?? testCase.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  log("info", `Running ${title}`);

  try {
    const context = await createContext(
      {
        log: (message) => log("info", message),
        signal: controller.signal,
      },
      testCase,
    );
    await withTimeout(testCase.run(context), timeoutMs, title);
    log("info", "Passed");
    return {
      id: testCase.id,
      title,
      status: "passed",
      durationMs: Date.now() - started,
      logs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test failed";
    log("error", message);
    const status = error instanceof AssertionError || error instanceof TestTimeoutError ? "failed" : "error";
    return {
      id: testCase.id,
      title,
      status,
      durationMs: Date.now() - started,
      error: message,
      logs,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}

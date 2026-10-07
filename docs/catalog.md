# Catalog contributor guide

The lab is headless first. The Angular app only calls the HTTP API. Cases, scenarios, suites, validation, and execution plans live in `packages/test-cases`. The runner executes a plan. The API stores that plan. The CLI talks to the API.

| Package | Owns | Must not depend on |
| --- | --- | --- |
| `packages/ocpp` | Frames, actions, connections | Express, MongoDB, Angular, CLI, simulator control |
| `packages/simulator-control` | Control-channel messages, fault rules, validation | Express, MongoDB, Angular, the catalog, the apps |
| `packages/test-runner` | Assertions, timeouts, logs, plan execution | Express, MongoDB, Angular, OCPP, simulator control |
| `packages/test-cases` | Case, scenario, and suite definitions, validation, selection | API, database, Angular, CLI |
| `apps/api` | Stations, catalog HTTP, run records | Angular |
| `apps/cli` | Non-interactive listing and runs | Angular |
| `apps/web` | Pages that call the API | Catalog `run` functions and the runner |

A normal case does not require edits to the API, UI, runner, database model, or CLI.

## Add a test case

Create one file and export it from `packages/test-cases/src/cases/index.ts`. That registration order is the sequence used when a suite selects cases by tag. Suites and scenarios otherwise run in the order they declare. Keep `soft-reset` last in any suite that includes it, because that case drops the socket.

```ts
import { Ocpp16Action } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const heartbeatCase = defineTestCase<OcppTestContext>({
  id: "heartbeat",
  title: "Heartbeat",
  description: "Trigger a Heartbeat and return the CSMS clock.",
  version: "1.6",
  tags: ["core", "trigger"],
  timeoutMs: 15_000,
  async run(ctx) {
    const incoming = ctx.peer.waitFor(Ocpp16Action.Heartbeat);
    const trigger = await ctx.peer.call<{ status: string }>(Ocpp16Action.TriggerMessage, {
      requestedMessage: Ocpp16Action.Heartbeat,
    });
    assertEqual(trigger.status, "Accepted", "TriggerMessage should be accepted");
    (await incoming).reply({ currentTime: new Date().toISOString() });
  },
});
```

Add the export to `packages/test-cases/src/cases/index.ts`.

## Add a scenario

A scenario is an ordered list of case ids. It has no runner or database code. The resolver executes those cases in the declared `caseIds` order and runs each case once.

```ts
import { defineScenario } from "../definitions.js";

export const smokeScenario = defineScenario({
  id: "smoke",
  title: "Boot and register",
  description: "Boot the charge point, then check heartbeat and connector status.",
  version: "1.6",
  tags: ["smoke"],
  caseIds: ["boot-notification", "heartbeat", "status-notification"],
});
```

Register it in `packages/test-cases/src/scenarios/index.ts`.

## Add a suite

A suite selects cases directly, through scenarios, or by tag. `excludeTags` removes matches. Suites cannot contain other suites.

```ts
import { defineSuite } from "../definitions.js";

export const configurationSuite = defineSuite({
  id: "configuration",
  title: "Configuration regression",
  description: "Cases tagged configuration.",
  version: "1.6",
  tags: ["configuration"],
  includeTags: ["configuration"],
});
```

Register it in `packages/test-cases/src/suites/index.ts`.

## Validation

`createCatalog` fails when the package loads if a definition is wrong. `pnpm lab -- catalog validate` imports that catalog and prints the counts. Errors name the definition and the bad reference.

Validation rejects:

- Duplicate ids inside cases, scenarios, or suites
- Missing case or scenario references
- Empty scenarios, or suites that select nothing
- Protocol versions other than `1.6` and `2.0.1`
- A suite that references another suite
- A case whose protocol version differs from its scenario or suite
- An empty or unknown selection

The resolver builds the execution plan in definition and request order:

1. Requested suites, in request order.
2. Inside each suite: explicit `caseIds`, then `scenarioIds`, then each scenario's `caseIds`, then `includeTags` matches in catalog registration order. `excludeTags` removes matches and leaves the remaining order in place.
3. Directly requested scenarios, in request order, each using its declared `caseIds` order.
4. Directly requested cases, in request order.

Each case runs once. The first time it appears sets its position. Later selections add their origins to that planned case and do not move it. Origin order follows the order those selections are encountered. Tag matches use catalog registration order because tags do not declare a sequence.

The stored plan records every origin (case, scenario, or suite) that selected the case.

Catalog version is `1`. Each run stores the requested selection and the resolved plan, including titles, tags, timeouts, and origins. Later catalog edits do not rewrite old reports. Runs created before plans existed still load; their `selection` and `plan` are null.

## Run without a browser

Start MongoDB, the API, and the mock charger. The UI is not required.

```bash
pnpm lab -- catalog list
pnpm lab -- catalog list --type case
pnpm lab -- catalog list --type scenario
pnpm lab -- catalog list --type suite
pnpm lab -- catalog validate

pnpm lab -- run --station CP001 --case heartbeat
pnpm lab -- run --station CP001 --scenario smoke
pnpm lab -- run --station CP001 --suite full-ocpp16
pnpm lab -- run --station CP001 --suite smoke --wait
pnpm lab -- runs list
pnpm lab -- runs show <run-id>
pnpm lab -- runs trace <run-id>
```

`--api-url` defaults to `http://localhost:8080`. `--json` prints JSON. `--wait` polls once a second for up to 120 seconds. `runs trace` prints the stored OCPP transcript for one run. Filters and storage limits are described in [tracing.md](tracing.md).

Exit codes: `0` when the command succeeds and a waited run passes, `1` when a run fails or the command or API request fails, `2` when a run ends in error, `3` when waiting times out.

The same selection can be posted to `POST /api/runs`:

```json
{
  "chargePointIdentity": "CP001",
  "selection": { "caseIds": ["heartbeat"], "scenarioIds": [], "suiteIds": [] }
}
```

`GET /api/catalog` returns cases, scenarios, and suites without `run` functions, plus `profile` metadata for the operator console. `POST /api/run-plans/resolve` previews a plan without creating a run. `GET /api/test-cases` and a body that only contains `caseIds` remain. Do not send both `selection` and `caseIds`.

Cases may declare `requirements`. Ordinary cases have none. A scenario or suite must declare every requirement used by its cases. The negative suite is separate from physical-charger regression; see [simulator-control.md](simulator-control.md). Reusable non-secret inputs such as connector id and timeouts live in a run profile; see [profiles.md](profiles.md).

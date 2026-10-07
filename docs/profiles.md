# Run profiles

A run profile supplies non-secret inputs for an OCPP test run: which connector and ID tag to use, which configuration value to try, and how long to wait. The API resolves one effective profile before it queues the run, stores that snapshot, and gives the same snapshot to every case.

Profiles are not credentials. Do not put passwords, API keys, private keys, payment data, or personal RFID data in a profile. The effective profile is stored on the run record and can appear in run responses. There is no encryption or secrets manager in this milestone.

The API does not read profile files. The CLI reads a local JSON file and sends the parsed object.

## Resolution order

1. Catalog defaults (`default-ocpp16`).
2. Parameters in the profile document. A profile may set only some parameters.
3. Explicit overrides from `--set` or the API `overrides` object.

Later layers replace earlier ones. Unknown fields are rejected at every layer. Defaults and caller objects are not mutated. The stored snapshot is complete, includes `schemaVersion`, and keeps the profile name. `overridden` lists the parameter names that were supplied by the profile or the overrides.

Execution uses the stored snapshot. Changing the built-in defaults later does not change a run that already has a snapshot.

Runs created before profiles existed have no stored snapshot. Reading one presents the current built-in default and `stored: false`. That presentation is not written back.

`GET /api/runs` returns the profile name and schema version. `GET /api/runs/:id` returns the full effective profile. Trace responses include the profile name and schema version once, not on every frame. OCPP payloads in the trace are the values the case sent, and the existing redaction rules still apply.

## Parameters

| Name | Type | Default | Constraint | Used by |
| --- | --- | --- | --- | --- |
| `connectorId` | integer | `1` | 0–1000 | StatusNotification, transaction lifecycle |
| `idTag` | string | `TEST-TAG-001` | 1–20 characters, the OCPP 1.6 idTag limit | Transaction lifecycle, remote-start-rejected |
| `transactionId` | integer | `1001` | 1–2147483647 | Transaction lifecycle |
| `configurationKey` | string | `HeartbeatInterval` | 1–100 characters | GetConfiguration, ChangeConfiguration |
| `configurationTestValue` | string | `45` | 1–500 characters | ChangeConfiguration |
| `callTimeoutMs` | integer | `10000` | 100–120000 | Calls made by every migrated case |
| `eventTimeoutMs` | integer | `15000` | 100–120000 | Waits for charge-point calls |
| `simulatorDelayMs` | integer | `300` | 0–30000 | Delayed TriggerMessage fault. 300ms leaves slack for container timers |
| `simulatorTimeoutMs` | integer | `500` | 100–30000 | Suppressed GetConfiguration. Long enough to time out, short enough for the case budget |

`connectorId` `0` means the charge point itself. Configuration keys on a real OCPP 1.6 charger are often limited to 50 characters even though the lab accepts 100.

GetConfiguration still requires `NumberOfConnectors` in addition to the configured key. ChangeConfiguration reads the original value, writes the test value, checks the read-back, and restores the original value in a `finally` block. It does not assume the original value is `60`. `Rejected` or `NotSupported` fails the case without writing a replacement.

## Commands

```bash
pnpm lab -- profiles show-default
pnpm lab -- profiles validate profiles/default-ocpp16.json
pnpm lab -- profiles resolve profiles/example-real-charger.json

pnpm lab -- run --station CP001 --suite full-ocpp16 --profile profiles/default-ocpp16.json --wait

pnpm lab -- run --station CP001 --suite transaction \
  --profile profiles/default-ocpp16.json \
  --set idTag=LAB-CARD-002 \
  --set connectorId=1 \
  --wait
```

`--profile` is a path to one local JSON file. A relative path is resolved from the directory where you started `pnpm`, so `profiles/default-ocpp16.json` works from the repository root. `--profile` overrides `LAB_PROFILE`. Duplicate `--set` keys are rejected. Integer overrides must be canonical base-10 integers (`1`, not `01` or `1.5`). String overrides stay strings, so `configurationTestValue=45` is the string `"45"`.

`profiles/example-real-charger.json` uses fake bench values only.

The Angular Cases page still posts `caseIds` and no profile. The API fills in the defaults.

## Add a parameter

Add the name to `PROFILE_PARAMETER_NAMES` and one entry in the parameter specs in `packages/test-cases/src/profile.ts`. Validation, CLI parsing, catalog metadata, and resolution all use that list. Then read the field from `ctx.profile.parameters` in the cases that need it. Do not add a second validator in the API or CLI.

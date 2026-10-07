# Simulator control

The mock charger speaks two WebSockets. They are not interchangeable.

| Channel | Path | Traffic |
| --- | --- | --- |
| OCPP | `/ocpp/:identity` | CALL, CALLRESULT, and CALLERROR only |
| Lab control | `/lab-control` | Test orchestration and fault injection only |

Subprotocol for the control channel is `pratvoltix-lab-control.v1`. Protocol version inside hello is `"1"`. Control messages never enter the OCPP trace. OCPP `DataTransfer` is not a control mechanism. A physical charger ignores the control channel and continues to answer ordinary OCPP calls.

`packages/simulator-control` owns message types, validation, fault-rule shapes, and the correlated request channel. It does not depend on Express, MongoDB, Angular, the catalog, or either app. `packages/ocpp` does not know about faults. `packages/test-runner` does not know about OCPP or simulator control.

## Control messages

Requests and responses share a `requestId`:

```json
{ "type": "request", "requestId": "abc", "action": "arm-fault", "payload": {} }
{ "type": "response", "requestId": "abc", "ok": true, "payload": {} }
```

Actions: `hello`, `arm-fault`, `clear-fault`, `clear-all-faults`, `list-faults`, `get-status`, `set-reconnect-storm`, `clear-reconnect-storm`.

The mock charger sends `hello` after it connects:

```json
{
  "protocolVersion": "1",
  "chargePointIdentity": "CP001",
  "simulatorName": "Pratvoltix Mock",
  "simulatorVersion": "0.1.0",
  "capabilities": ["simulator-control"]
}
```

An incompatible `protocolVersion` gets an error response and the socket closes. Every message is validated. Pending requests are bounded, time out, and fail when the socket closes. A second control connection for the same identity replaces the first: the older socket closes and its pending requests fail. Duplicate request ids are rejected while pending. Control failures are logged and do not close the OCPP socket or crash the API.

The mock charger reconnects with exponential backoff starting at 200ms and capped at 5 seconds. OCPP keeps running while the control channel is down. On each control reconnect the charger drops its in-memory faults before hello, so a new connection does not revive old rules.

## Fault rules

Rules are one-shot and apply only to incoming CSMS calls handled by the mock charger:

```ts
{
  id: "reset-call-error",
  match: { action: "Reset", occurrence: 1 },
  effect: { type: "call-error", errorCode: "InternalError", description: "Injected reset failure" },
  consume: "once"
}
```

Effects in this milestone:

- `delay` waits up to 30 seconds, then handles the call normally. The ceiling matches the run-profile `simulatorDelayMs` limit.
- `call-result` returns the given CALLRESULT payload.
- `call-error` returns a CALLERROR. `errorCode` and `description` are required. `details` is an optional JSON object.
- `suppress-response` leaves the CALL unanswered so the CSMS timeout can be tested.
- `disconnect` closes only the OCPP socket. The control socket stays up.

`occurrence` defaults to the next matching call (`1`). Rules are checked in arm order. A call increments the occurrence count of each matching rule until one reaches its occurrence; that rule is consumed and later calls do not see it. Active rule ids must be unique. At most 16 rules can be armed. There is no callback or expression language.

Fault state is memory only. Restarting the mock charger drops it.

## Reconnect storm

The `set-reconnect-storm` and `clear-reconnect-storm` actions configure burst reconnection behavior for CSMS resilience testing. Unlike fault rules, reconnect storm configuration is not tied to a specific OCPP action and persists until explicitly cleared.

```json
{ "type": "request", "requestId": "storm1", "action": "set-reconnect-storm", "payload": {
  "burstCount": 5,
  "burstDelayMs": 100,
  "intervalMs": 2000
}}
```

| Field | Description |
| --- | --- |
| `burstCount` | Number of rapid reconnections per burst (1–100) |
| `burstDelayMs` | Delay between reconnections within a burst (0–30000ms) |
| `intervalMs` | Delay before starting the next burst cycle (0–30000ms) |

When a reconnect storm is configured, after each socket close the simulator reconnects with `burstDelayMs` delay until `burstCount` reconnections have occurred. Then it waits `intervalMs` before starting the next burst. The storm continues until `clear-reconnect-storm` is called.

```json
{ "type": "request", "requestId": "storm2", "action": "clear-reconnect-storm", "payload": {} }
```

Reconnect storm configuration is independent of fault rules. Clearing faults does not clear the storm. The storm is memory only and resets when the mock charger restarts.

## Cleanup

`withFault(controller, rule, operation)` arms the rule, runs the operation, and clears it in `finally`. Clearing an already consumed rule is success. An arm failure is reported as `Failed to arm fault "<id>": ...`. A cleanup failure is appended to the original error so an assertion failure stays an assertion failure.

A run whose plan requires `simulator-control` clears all faults before the first case and again when the run finishes. The run is rejected with `409` before it is queued when the station is missing that capability, or when the fault list cannot be confirmed empty. The last cleanup status is on the simulator record. Ordinary physical-charger runs do not touch the simulator registry.

## Requirements

```ts
requirements: ["simulator-control"]
```

Existing cases default to no requirements. A scenario or suite must declare every requirement used by its cases, or catalog creation throws. The resolved plan stores requirements, and `GET /api/catalog` returns them. There is no skipped status. If capability validation fails, the API responds:

```json
{ "error": "Station CP001 is missing capability simulator-control required by cases: reset-call-error" }
```

Simulator-dependent cases call `requireSimulator(ctx)`. That throws one internal error if a case runs without a controller.

## Negative suite

Scenario `negative-responses` and suite `simulator-negative` contain, in order:

1. `remote-start-rejected` — one-shot CALLRESULT `{ "status": "Rejected" }` for `RemoteStartTransaction`.
2. `reset-call-error` — one-shot CALLERROR `InternalError` for `Reset`.
3. `get-configuration-timeout` — `suppress-response` for `GetConfiguration`, with a short call timeout, then a normal call.
4. `delayed-trigger-heartbeat` — a 200ms delay on `TriggerMessage`. The response must still succeed, take at least the delay minus a small timer allowance, and finish inside the case timeout.

```bash
pnpm lab -- run --station CP001 --suite simulator-negative --wait
pnpm lab -- simulators list
pnpm lab -- simulators show CP001
```

`--json` prints the API body. Human output shows identity, connected state, protocol version, simulator version, capabilities, active fault count, and cleanup state.

`smoke` and `full-ocpp16` do not include these cases. `full-ocpp16` stays usable against a physical charger. The negative suite is excluded because a physical charger has no control channel, and these cases assert injected behavior rather than the charger's own responses. Disconnect is implemented but not part of the shared suite, so one case cannot drop the socket for the rest.

## Add another simulator-only case

1. Add a case file that sets `requirements: ["simulator-control"]` and tags such as `negative` and `simulator`.
2. Arm the rule with `withFault` so cleanup runs in `finally`.
3. Register it after `soft-reset` in `cases/index.ts`.
4. Add it to scenario `negative-responses` or a new scenario whose declared requirements cover the case.
5. Keep it out of `smoke` and `full-ocpp16`.
6. Do not put a `disconnect` effect in a multi-case suite.

## Status API

`GET /api/simulators` and `GET /api/simulators/:identity` return connection state, protocol version, simulator version, capability names, fault summaries (`id`, `action`, `occurrence`, `effectType`), and the last cleanup status. They do not return fault payloads. There is no public endpoint for arming faults. Tests use the internal controller.

The OCPP station registry and the simulator registry are separate. A station can be connected while simulator control is down.

## Environment

| Variable | Role |
| --- | --- |
| `CSMS_URL` | Legacy bootstrap OCPP base URL for the mock charger, for example `ws://api:8080/ocpp`. A per-run external target does not change this idle connection. |
| `TARGET_CSMS_URL` | External OCPP URL template read by the API process. Example: `ws://host.docker.internal:8080/ocpp/{stationId}` (CSMS websocket-gateway). Precedence is the per-run request, then this variable, then the embedded default. Put secrets here. Do not pass them with `--target-url`: package managers and process listings can echo raw arguments. |
| `CONTROL_URL` | Control endpoint, for example `ws://api:8080/lab-control` |
| `CHARGE_POINT_ID` | Identity used for both channels |
| `SIMULATOR_NAME` | Name sent in hello |
| `SIMULATOR_VERSION` | Version sent in hello |

Docker Compose points the mock charger at the `api` service name. No extra host port is published for control. The charger retries the control channel on its own, so startup order does not have to be exact beyond the API becoming reachable.

## Limits

Not in this milestone: malformed-frame injection, message duplication, reordering, bandwidth limits, persisted faults, skipped cases, or a public mutation API. Fault payloads are not stored in the run transcript. Redaction of OCPP traces is unchanged and does not scan control messages, because those messages are not traced.

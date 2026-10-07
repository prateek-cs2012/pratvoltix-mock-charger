# Supported features (mock charger)

End-to-end list of what **`apps/mock-charger`** supports today on **`main`** (`caa6977`, Gaps 1–10). This is a lab OCPP **1.6** charge point for CSMS scenario testing — not a production EVSE firmware. Features below are drawn from the mock handlers, lab-control actions, catalog cases/scenarios, and Ashish CSMS validation on Mac (PRs #13, #20–#22).

Related docs: [catalog](catalog.md) · [simulator control](simulator-control.md) · [profiles](profiles.md) · [tracing](tracing.md)

## Overview / purpose

| Item | Detail |
| --- | --- |
| Protocol | OCPP 1.6 over WebSocket (subprotocol `ocpp1.6`) |
| Identity | Default `CP001` (Docker / `.env`) |
| Lab stack | API `:18080`, UI `:14200`; optional external CSMS via `TARGET_CSMS_URL` (e.g. `ws://host.docker.internal:8080/ocpp/{stationId}`) |
| Dual channel | OCPP `/ocpp/:id` + lab control `/lab-control` (subprotocol `pratvoltix-lab-control.v1`) |
| Catalog | Cases → scenarios → suites; operator UI `/catalog` or `pnpm lab` |

Gaps **1–10** are on `main`. Non-blocking follow-ups: [#18](https://github.com/prateek-cs2012/pratvoltix-mock-charger/issues/18), [#19](https://github.com/prateek-cs2012/pratvoltix-mock-charger/issues/19).

---

## Connectivity & session lifecycle

| Capability | Behavior | Catalog / notes |
| --- | --- | --- |
| BootNotification | On connect / announce; applies CSMS heartbeat interval when Accepted | `boot-notification`, smoke |
| Heartbeat | Periodic + TriggerMessage | `heartbeat` |
| StatusNotification | Announces connector status on boot and on transitions | `status-notification` |
| Soft Reset | Accepted; drops OCPP socket and reboots session | `soft-reset` (keep last in suites) |
| Reconnect storm | Lab-control burst reconnects for CSMS resilience | `reconnect-storm` |
| Mid-transaction disconnect | Fault-inject disconnect; recover Boot + Charging; stop tx | `disconnect-mid-tx` |
| TriggerMessage | Boot, Heartbeat, StatusNotification, MeterValues | Several cases |
| Outbound delay | Delay outbound OCPP (Authorize path, etc.) | `outbound-delay` |
| Malformed / CallError / suppress | Fault injection on inbound CSMS calls | `malformed-response`, `reset-call-error`, `get-configuration-timeout`, `delayed-trigger-heartbeat` |

Validated green (Mac/CSMS lab): reconnect-storm, disconnect-mid-tx, soft-reset path in PR #13 gate; Gap 8–10 regressions stayed green.

---

## Transactions

| Capability | Behavior | Catalog |
| --- | --- | --- |
| RemoteStart / RemoteStop | Full lifecycle: Authorize → StartTransaction → Charging → MeterValues → Stop → Available | `transaction-lifecycle` |
| RemoteStart rejected | **Fault-injected** one-shot CallResult `Rejected` (negative suite / `withFault`) — not a natural Occupied/Unavailable reject. Native reject today is active-tx / missing `idTag` only. | `remote-start-rejected` |
| Local cable start | Control `local-start`: Preparing → Authorize → StartTransaction → Charging (not RemoteStart) | `local-cable-start` (**Gap 8**) |
| Local stop | Control `local-stop` with `StopTransaction.reason` (e.g. Local) + Finishing → Available | `local-cable-start` |
| Local auth list skip | Accepted idTag in local list skips Authorize on start | `local-auth-skip` (**Gap 3**) |
| AuthorizeRemoteTxRequests=false | Skips Authorize on RemoteStart when config applied | Unit + Gap 10 config path |
| Duplicate Start / Stop | Idempotent retry via lab helpers | `duplicate-start`, `duplicate-stop` |
| Offline queue / upload | Queue offline txs; upload when back online | `offline-upload` |
| Stop-idempotency cache | Cleared on new StartTransaction (lab reuses transactionIds across cases) | Gap 10 |

Stop reasons supported on the local/finish path include values such as `Local`, `Remote`, `EVDisconnected` (and related finish helpers). RemoteStop drives the remote reason path.

---

## Connector status path

Statuses the mock can be in / emit (`ConnectorStatus`):

`Available` · `Preparing` · `Charging` · `SuspendedEVSE` · `SuspendedEV` · `Finishing` · `Reserved` · `Unavailable` · `Faulted`

| Path | How |
| --- | --- |
| Preparing → Charging | Local cable start |
| Charging → Finishing → Available | Local or remote stop |
| Suspended* / Faulted mid-tx | Control `set-connector-status` (does not end tx) |
| Unavailable / Available | `ChangeAvailability` Inoperative / Operative |
| Reserved ↔ Available | `ReserveNow` / `CancelReservation` |
| Scheduled availability | ChangeAvailability returns Scheduled when a transaction is active |

Catalog: `local-cable-start`, `change-availability`, `reserve-now`, `status-notification`.

---

## CSMS → CP actions

Handlers that return **Accepted** (or documented status) rather than blanket `NotSupported`:

| Action | Behavior | Catalog |
| --- | --- | --- |
| ChangeAvailability | Operative/Inoperative → Available/Unavailable; Scheduled if tx active | `change-availability` (**Gap 9**) |
| ReserveNow / CancelReservation | Reserved status round-trip | `reserve-now` |
| SetChargingProfile / ClearChargingProfile / GetCompositeSchedule | Accepted stubs; profiles stored in memory | `charging-profile` |
| UpdateFirmware | CallResult + FirmwareStatusNotification: Downloading → Downloaded → Installing → Installed | `firmware-diagnostics` |
| GetDiagnostics | `fileName` + DiagnosticsStatusNotification: Uploading → Uploaded | `firmware-diagnostics` |
| SendLocalList / GetLocalListVersion | Local authorization list | `local-auth-skip` / Gap 3 |
| GetConfiguration / ChangeConfiguration | See [Config & metering](#config--metering-realism) | `get-configuration`, `change-configuration`, `config-meter-realism` |
| ClearCache | Clears authorization cache | Used in cleanup paths |
| UnlockConnector | Returns Unlocked | — |
| Reset | Soft/Hard as implemented; Soft drops socket | `soft-reset` |
| DataTransfer | **Rejected** (not a control channel) | — |
| Unknown actions | `NotSupported` CALLERROR | — |

Scenario **`csms-actions`**: `change-availability`, `reserve-now`, `charging-profile`, `firmware-diagnostics` (Ashish MERGE on PR #21).

---

## Config & metering realism

Mutable keys (ChangeConfiguration **Accepted** when valid; GetConfiguration reflects live values):

| Key | Effect |
| --- | --- |
| `HeartbeatInterval` | Reschedules heartbeat |
| `MeterValueSampleInterval` | Seconds between periodic MeterValues while tx active; `0` disables |
| `AuthorizeRemoteTxRequests` | `false` skips Authorize on RemoteStart |

Read-only example: `NumberOfConnectors` = `1`.

Other keys: rejected / not supported as implemented (not silently ignored as applied).

Periodic **MeterValues** while charging after interval is set — validated by `config-meter-realism` (**Gap 10**, PR #22 → `caa6977`).

Scenario **`configuration`**: `get-configuration`, `change-configuration`, `config-meter-realism`.

---

## Lab / control API surface

Control actions (see also [simulator-control.md](simulator-control.md); Gap 8 added the last three):

| Group | Actions |
| --- | --- |
| Session | `hello`, `get-status`, `connect-ocpp`, `disconnect-ocpp`, `emit-ocpp`, `ocpp-frame`, `ocpp-state` |
| Faults | `arm-fault`, `clear-fault`, `clear-all-faults`, `list-faults` |
| Reconnect | `set-reconnect-storm`, `clear-reconnect-storm` |
| Delay | `set-outbound-delay`, `clear-outbound-delay` |
| Local auth / offline | `set-local-auth-list`, `get-local-auth-list`, `queue-offline-transaction`, `upload-offline-transactions` |
| Tx helpers | `retry-start-transaction`, `retry-stop-transaction`, `restore-transaction-state`, `reset-connector-idle` |
| Local cable / status | `local-start`, `local-stop`, `set-connector-status` |

Fault effects: `delay`, `call-result`, `call-error`, `suppress-response`, `disconnect`, `malformed-response`.

### Catalog scenarios (ids)

| Scenario | Case ids |
| --- | --- |
| `smoke` | `boot-notification`, `heartbeat`, `status-notification` |
| `transaction` | `transaction-lifecycle` |
| `configuration` | `get-configuration`, `change-configuration`, `config-meter-realism` |
| `csms-actions` | `change-availability`, `reserve-now`, `charging-profile`, `firmware-diagnostics` |
| `extended-simulator` | `outbound-delay`, `local-auth-skip`, `offline-upload`, `local-cable-start` |
| `negative-responses` | `remote-start-rejected`, `reset-call-error`, `get-configuration-timeout`, `delayed-trigger-heartbeat`, `malformed-response` |

Suites include `smoke`, `transaction`, `configuration`, `simulator-negative`, `full-ocpp16` (soft-reset last).

---

## Known limitations / backlog

| Item | Notes |
| --- | --- |
| [#18](https://github.com/prateek-cs2012/pratvoltix-mock-charger/issues/18) | Sticky reconnect-storm flaps after `clearReconnectStorm` until mock restart — **non-blocking** |
| [#19](https://github.com/prateek-cs2012/pratvoltix-mock-charger/issues/19) | Occasional Authorize-timeout flake on `duplicate-*` after heavy reconnect — **non-blocking** |
| Single connector | `NumberOfConnectors` = 1 |
| Charging profiles / firmware / diagnostics | Lab stubs (Accepted + status progression); not full power/firmware realism |
| DataTransfer | Rejected; use lab-control for orchestration |
| OCPP 2.0.1 | Action names exist in `packages/ocpp`; executable catalog + mock speak **1.6** only |
| Lab only | Do not expose the stack to the public internet |

---

## Validation snapshot (Ashish, Mac)

| Gate | SHA / PR | Result |
| --- | --- | --- |
| Gaps 1–7 | PR #13 @ `9f71c43` (merged) | MERGE |
| Gap 8 | PR #20 @ `936a3d7` | MERGE |
| Gap 9 | PR #21 @ `81fb993` | MERGE |
| Gap 10 | PR #22 @ `fe1ce46` → main `caa6977` | MERGE |

Artifacts under `artifacts/ashish-csms-validation-*.md` (local Mac checkout; not required in git).

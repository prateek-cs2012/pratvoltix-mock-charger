# Protocol traces

Each test run can record the OCPP frames exchanged with the selected charge point. Capture is headless. The Angular UI does not subscribe to frames, and this milestone does not add a live stream.

## Where frames are observed

`OcppConnection` in `packages/ocpp` is the only parser. `observe()` receives inbound and outbound frames as they pass through that connection. Direction is relative to the connection (`inbound` or `outbound`). Unsubscribing stops delivery. An observer that throws does not change protocol handling.

The package does not know about test runs or case ids. The API maps a CSMS connection's inbound frames to `charge-point-to-csms` and outbound frames to `csms-to-charge-point`.

`runPlan` accepts optional `lifecycle` hooks, `onCaseStart(step)` and `onCaseFinish(step, result)`. Hooks run in that order around each step, including unknown case ids. A hook that throws does not replace the case result or stop the plan. The runner stays free of OCPP types.

## What a run stores

`executeRun` subscribes to the station connection before the plan starts and unsubscribes in a `finally` block. Nothing is captured while no run is active. The existing one-active-run lock means a station has at most one collector.

Frames seen while a case is executing store that case id. Frames between cases omit `caseId`. `CALLRESULT` and `CALLERROR` keep the action of the matching `CALL` when the connection still knows that unique id.

The transcript is saved on the run document:

```ts
{
  summary: {
    capturedEntries: number;
    droppedEntries: number;
    truncatedEntries: number;
    truncated: boolean;
  },
  entries: [/* trace entries */];
}
```

`truncated` is true when any frame was shortened or dropped. `sequence` numbers the frames that were kept, starting at 1, in observation order. `at` is an ISO-8601 UTC timestamp.

Runs created before traces existed have no `trace` field. `GET /api/runs` and `GET /api/runs/:id` still load them. They expose a zero summary and no entries. `GET /api/runs/:id/trace` returns an empty transcript of the same shape.

Ordinary run responses include only the summary. The entries are only on:

```text
GET /api/runs/:id/trace
```

Optional filters are exact matches: `caseId`, `action`, `direction` (`csms-to-charge-point` or `charge-point-to-csms`), and `messageType` (`CALL`, `CALLRESULT`, `CALLERROR`, `UNKNOWN`). Invalid filters return 400. An unknown run returns 404. The summary always describes the full capture, not the filtered page.

## Limits

| Limit | Default |
| --- | --- |
| Entries kept per run | 2,000 |
| Raw or serialized payload bytes per entry | 64 KiB |
| Approximate transcript bytes per run | 4 MiB |

Past the entry or transcript cap, later frames increment `droppedEntries` and the run continues. Oversized raw text is cut on a UTF-8 boundary. `originalRawBytes` is the wire size. An oversized parsed payload is stored as a shortened JSON string and `originalPayloadBytes` records the uncut size. `truncatedEntries` counts stored frames that were shortened.

Parsed frames whose redacted payload serializes to more than 1 KiB do not also store `raw`. Smaller frames and every `UNKNOWN` frame keep a raw string. That avoids a second copy of large `MeterValues` bodies.

## Redaction

Before anything is kept, a copy of the payload is walked. Object keys `password`, `secret`, `authorizationKey`, `apiKey`, and `token` are replaced with `"[REDACTED]"` at any depth, in objects and arrays. Matching is case-insensitive and exact. The object handed to the OCPP call handler is not modified.

Raw text is redacted the same way when it is JSON, then re-serialized. Whitespace and number formatting can change, so stored `raw` may not match the socket bytes. Non-JSON text only has obvious `"key": value` pairs for those key names replaced. Values under other names (`idTag`, `passwordHash`), secrets inside opaque strings, and encodings this pass does not recognize can remain.

## Inspect a trace

```bash
pnpm lab -- runs trace <run-id>
pnpm lab -- runs trace <run-id> --case heartbeat --action Heartbeat --direction charge-point-to-csms --message-type CALL
pnpm lab -- runs trace <run-id> --json
```

Human output is one summary line per frame (sequence, time, direction, message type, action, unique id, case id) and then the payload or error. A truncated transcript prints a warning. `--json` prints the API body unchanged. Invalid filters exit non-zero. The command does not prompt.

The UI stays a client of the run and catalog APIs. Protocol diagnosis belongs in the trace endpoint and the CLI so a lab can be run without a browser.

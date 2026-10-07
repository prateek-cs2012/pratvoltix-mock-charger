# CI reports

`packages/test-reporting` turns a completed run and its redacted trace into files. It does not talk to the API or the filesystem. The CLI polls the existing run and trace endpoints, writes the bundle, and chooses the process exit code.

The Angular app does not generate reports. Set `TARGET_CSMS_URL` on the API process when CI should target an external CSMS. Supply that URL through the environment. Do not put credentials in `--target-url`, because package managers and operating-system process listings may echo raw arguments. An explicit `--target-mode embedded` keeps a run on the lab CSMS even when the variable is set.

## Bundle

```text
artifacts/ocpp/<run-id>/
  manifest.json
  run.json
  junit.xml
  trace.ndjson
  trace-summary.json
  summary.txt
```

`run.json` is the normalized run: plan, profile parameters, logs, and trace counts. It does not contain protocol frames. `trace.ndjson` is one already-redacted API trace entry per line, in API order. `manifest.json` is written last and lists SHA-256 hashes of the other files. `generatedAt` is the only timestamp the generator adds.

`--no-trace` omits the two trace files and records `traceExport: "not-requested"`.

`--overwrite` replaces those known filenames in an existing run directory. It does not delete the directory or any other file. Without `--overwrite`, an existing run directory is an error.

## JUnit

One `<testsuite>` per run. The name is `Pratvoltix OCPP · <station> · <selection>`. A direct case selection uses the case ids. A historical run without a selection or plan uses `historical`.

- `passed` is a successful `<testcase>`.
- `failed` is `<failure>`.
- `error` is `<error>`.

There is no skipped state. Totals and `time` come from the case results. Duration uses seconds with a `.` decimal separator. Run properties include the station, catalog version, profile name and schema, selection, and trace counts when those values exist. Case properties include the id, protocol version, tags, requirements, and origins when the stored plan has them. Info logs go to `<system-out>` and error logs go to `<system-err>`.

## Exit codes

`ci run` always waits for a terminal run, then writes the bundle.

| Code | Meaning |
| --- | --- |
| 0 | Run passed and required artifacts were written |
| 1 | Run completed with failed cases, and the bundle was written |
| 2 | Run completed with an execution error, and the bundle was written |
| 3 | Timed out waiting for the run. No bundle |
| 4 | Report validation or filesystem failure. No trustworthy bundle |
| 5 | Bundle was written, then a trace policy failed |
| 6 | Bad arguments, bad profile input, a run that is still queued or running, or an API failure |

`artifacts export` uses the same artifact and trace-policy codes. A successful export of a failed or error run exits 0, because that command only publishes files. `runs show` and `run --wait` keep their existing codes.

If the run fails and the bundle cannot be written, the exit code is 4. The message includes the run status. If the bundle is written and a trace policy fails, the exit code is 5 even when cases also failed. The JSON result still includes `runStatus`.

## Trace policy

By default a passing run is successful even when the stored trace is truncated. `summary.txt` and the CLI print a warning.

`--require-trace` exits 5 when `capturedEntries` is 0. Historical runs from before tracing fail this check. `--fail-on-truncated-trace` exits 5 when `truncated` is true. Both flags still leave the partial bundle on disk, and the summary and manifest say why.

`--no-trace` cannot be combined with either flag.

## Commands

```bash
pnpm lab -- ci run \
  --station CP001 \
  --suite full-ocpp16 \
  --profile profiles/default-ocpp16.json \
  --output artifacts/ocpp

pnpm ci:smoke

pnpm lab -- artifacts export <run-id> --output artifacts/ocpp
```

`ci run` accepts the same `--station`, `--case`, `--scenario`, `--suite`, `--profile`, `--set`, `--api-url`, `--timeout-ms`, and `--interval-ms` options as `run`. Relative profile and output paths resolve from the directory where `pnpm` was started.

## Generic CI

Run the lab stack, then `pnpm ci:smoke` or `pnpm lab -- ci run ...`. Publish `artifacts/ocpp` as a build artifact and point the JUnit reporter at `artifacts/ocpp/**/junit.xml`.

GitHub Actions can upload the directory with `actions/upload-artifact` and publish tests with a JUnit action. Keep the artifact for a limited retention window.

Jenkins can archive the directory and call `junit 'artifacts/ocpp/**/junit.xml'`. GitLab can use `artifacts:reports:junit` with the same glob and `artifacts:paths` for the rest of the bundle. The exit codes above are process codes; Jenkins and GitLab still read the JUnit file for the case list.

Do not commit `artifacts/`. The directory is gitignored.

## Sensitive data

Profiles are persisted on the run and copied into `run.json`. They must not contain secrets or personal data. Trace files are the API's already-redacted transcript. Redaction covers known secret field names; it does not detect every sensitive value. Treat trace artifacts as operationally sensitive protocol data and keep them with the same access limits as the lab.

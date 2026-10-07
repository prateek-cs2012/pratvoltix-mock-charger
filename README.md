# Pratvoltix OCPP Lab

TypeScript monorepo for exercising OCPP 1.6 charge points. The Angular app is a client of the headless API. Shared packages own the protocol, the runner, and the catalog of cases, scenarios, and suites.

## Layout

- `apps/web` — Angular client of the HTTP API
- `apps/api` — headless CSMS, catalog, run, and report API
- `apps/cli` — headless client for listing and running the catalog
- `apps/mock-charger` — charge point that connects to the CSMS and answers the catalog
- `packages/ocpp` — OCPP framing, actions, and connections
- `packages/test-runner` — execution engine for an already resolved plan
- `packages/test-cases` — cases, scenarios, suites, validation, and selection
- `packages/test-reporting` — JUnit, NDJSON, summaries, and artifact manifests

How to add and run catalog content is in [docs/catalog.md](docs/catalog.md). How a run records OCPP frames is in [docs/tracing.md](docs/tracing.md). How the mock charger accepts fault injection is in [docs/simulator-control.md](docs/simulator-control.md). How run inputs are supplied is in [docs/profiles.md](docs/profiles.md). How CI exports JUnit and trace artifacts is in [docs/ci.md](docs/ci.md).

OCPP 1.6 and 2.0.1 share the same CALL / CALLRESULT / CALLERROR framing. The executable catalog and mock station speak 1.6. The protocol package also exports the 2.0.1 action names.

## Docker

```bash
pnpm deploy
```

That rebuilds the API, web, and mock-charger images and restarts the stack in the background. `docker compose up --build` does the same in the foreground.

- Lab UI: http://localhost:4200
- API: http://localhost:8080
- Charge point URL: `ws://localhost:4200/ocpp/CP001` (subprotocol `ocpp1.6`)
- MongoDB: `mongodb://localhost:27017/pratvoltix`

The mock charger connects as `CP001` on OCPP and, separately, on the lab-control channel. From the host:

```bash
pnpm lab -- catalog list
pnpm lab -- run --station CP001 --suite smoke --wait
pnpm ci:smoke
```

The Angular operator console at `/catalog` launches runs through the API. `/cases` redirects there. The full OCPP 1.6 suite lists soft reset last because it drops the socket.

This is a lab stack. Do not expose it to the public internet.

## Local development

```bash
pnpm install
pnpm test
pnpm build
docker compose up mongo -d
pnpm dev:api
pnpm dev:web
pnpm dev:mock
```

Copy `.env.example` if you want different ports or a remote MongoDB. `dev:web` proxies `/api`, `/health`, and `/ocpp` to `http://localhost:8080`.

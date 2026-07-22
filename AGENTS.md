# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains a Chrome Manifest V3 extension and a Cloudflare
Workers backend. Extension code lives in `src/`: `content/` extracts articles,
`popup/` contains the React UI, `background/` coordinates extension state,
`offscreen/` runs Supertonic TTS, and `shared/` holds common types/constants.
Static extension files and voice presets are in `public/`. End-to-end tests
are in `tests/e2e/`; backend code, D1 schema, and Wrangler configuration are
in `backend/`. Product and deployment guidance is under `_docs/`.

## Build, Test, and Development Commands

Run `pnpm install` from the repository root before development.

- `pnpm dev` starts the extension development build and writes output to
  `dist/`; load that directory with Chrome's “Load unpacked” flow.
- `pnpm build` runs strict TypeScript checking and creates the production
  extension bundle.
- `pnpm test:e2e` runs the Playwright suite against bundled Chromium. Tests
  run sequentially; use `CI=true pnpm test:e2e` to enable CI-only retries and
  `test.only` protection.
- `pnpm test:unit` runs lightweight Node tests for concurrency-sensitive
  helpers.
- `pnpm --filter readit-backend dev` starts the local Worker.
- `pnpm --filter readit-backend deploy` deploys the backend; configure D1 and
  secrets as described in `_docs/DEPLOYMENT.md`.

## Coding Style & Naming Conventions

Use strict TypeScript and React functional components. Follow the checked-in
Biome configuration: tabs for indentation, four-space tab width, LF endings,
and a 140-character line width. Keep component files in PascalCase (for
example `App.tsx`), utility/module files in lowercase or snake-style names
matching the existing code, and Playwright specs as `*.spec.ts`. Keep domain
terms consistent with `CONTEXT.md` (`Article`, `Voice`, `Voice Style`, `Tier`,
`Activation`, and `License Key`).

## Testing Guidelines

Playwright is the current test framework. Add user-visible extension behavior
to `tests/e2e/`, reuse `tests/e2e/fixtures.ts`, and name tests after the
behavior they verify. Build the extension before running tests when `dist/`
may be stale. There is currently no stated coverage threshold.

## Commit & Pull Request Guidelines

The repository has no Git commits yet, so no established commit convention
can be inferred. Use short, imperative messages such as `Add pause control`.
Pull requests should explain the behavior change, list verification commands,
link a related issue when one exists, and include screenshots or a short
recording for popup/UI changes. Do not commit secrets; use Wrangler secrets or
local `.dev.vars` for backend credentials.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

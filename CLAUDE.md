# Repository Guidelines

## Runtime & Package Manager
This project uses **Bun 1.4+** exclusively. Do NOT use `pnpm`, `npm`, `npx`, or `node`.
- Package management: `bun install`, `bun add <pkg>`, `bun remove <pkg>`
- Script execution: `bun run <script>`, `bun scripts/<file>`
- Binary runner: `bunx <tool>` (e.g., `bunx playwright`, `bunx biome`, `bunx wrangler`, `bunx web-ext`)
- Unit tests: `bun test` / `bun test:unit`
- E2E tests: `bun run test:e2e` / `bunx playwright test`
- Workspace filters: `bun run --filter <package> <script>`

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

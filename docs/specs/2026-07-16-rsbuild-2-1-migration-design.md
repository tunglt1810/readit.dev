# Rsbuild 2.1 Migration Design

## Goal

Migrate the extension build from Rsbuild 2.0 to the latest exact patch releases in the Rsbuild 2.1 line, adopt the stable performance capabilities selected for this project, and replace low-level Rspack configuration with supported Rsbuild APIs without changing the Chrome MV3 runtime or release artifact contract.

## Scope

This migration covers:

- `@rsbuild/core` and `@rsbuild/plugin-react` upgrades to the latest compatible 2.1 patch releases;
- removal of the direct `@rspack/core` dependency after eliminating its only config-level imports;
- Rust React Compiler for the existing React 19 popup;
- persistent build cache with benchmark-aware invalidation;
- modernization of `rsbuild.config.ts` using semantic Rsbuild configuration;
- build-performance and artifact comparison before and after migration;
- the full extension verification chain.

The migration does not change application behavior, extension permissions, runtime dependencies, chunking strategy, product scope, or backend code.

## Dependency Strategy

Use exact versions rather than ranges, matching the repository's current dependency policy. Resolve the latest published patch releases in the 2.1 line at implementation time for:

- `@rsbuild/core`;
- `@rsbuild/plugin-react`.

Remove the direct `@rspack/core` development dependency. The project only imports it from `rsbuild.config.ts` for `CopyRspackPlugin` and `Compiler`; both usages will be replaced by Rsbuild APIs. Rsbuild will therefore own and resolve its compatible Rspack 2.1 version.

No runtime dependency will be added.

## Performance Configuration

Enable the Rust React Compiler through `pluginReact` with an explicit React 19 target. This applies compile-time memoization while avoiding the Babel-based compiler and any React 17/18 compatibility runtime.

Enable `performance.buildCache`. Include `process.env.READIT_VI_BENCHMARK` in `cacheDigest` because that variable changes the offscreen entry and output root. This keeps normal extension builds and Vietnamese benchmark builds from reusing incompatible cache entries.

Retain `splitChunks: false`. The background and content-script entries are referenced directly by the Chrome manifest and do not have an HTML loader that can discover additional asynchronous entry chunks.

Rspack 2.1 production optimizations such as stable pure-function analysis, branch-aware dependency pruning, and improved constant export output are accepted through the upgrade defaults. No redundant experimental flags will be added.

## Rsbuild Configuration Modernization

Replace low-level configuration only where a documented Rsbuild API preserves the same behavior:

1. Move package export conditions from `tools.rspack.resolve.conditionNames` to `resolve.conditionNames`.
2. Set `output.distPath.js` to the output root and move the conditional JavaScript filename function to `output.filename.js`. Keep `background.js` and `content_script.js` unhashed at the output root; keep hashed files under `assets/` for other JavaScript entries.
3. Replace `CopyRspackPlugin` with `output.copy`.
4. Disable the default production copy of `public/` to avoid duplicate copying. Use `output.copy` for the selected public extension package and ONNX Runtime Asyncify files during both development and production builds.
5. Exclude `.DS_Store` files from copied output.
6. Express the `background` and `content_script` entries as entry description objects with `html: false`. Remove the custom emit-stage plugin that deletes their generated HTML files.
7. Replace the scan and mutation of internal HTML plugin instances with `tools.htmlPlugin(config, { entryName })`. Preserve the exact popup and offscreen HTML output paths.

After these changes, `rsbuild.config.ts` must not import from `@rspack/core` or use `tools.rspack`.

## Artifact Contract

The build must continue to produce these required paths:

- `manifest.json`;
- `background.js`;
- `content_script.js`;
- `src/popup/popup.html`;
- `src/offscreen/offscreen.html`;
- `THIRD_PARTY_NOTICES.txt`;
- `assets/` including icons, voices, and Vietnamese normalizer assets;
- `ort-wasm-simd-threaded.asyncify.mjs`;
- `ort-wasm-simd-threaded.asyncify.wasm`.

The build must not contain:

- `background.html`;
- `content_script.html`;
- `.DS_Store` at any depth.

The built manifest permissions, host permissions, paths, and CSP remain unchanged.

## Measurement and Verification

Before changing dependencies, capture in `.tmp`:

- the installed Rsbuild, React plugin, and Rspack versions;
- a production build duration;
- the `dist` file list;
- sizes of the main JavaScript and CSS outputs.

After migration:

1. run a clean production build and record its duration;
2. run a second warm build and record its duration;
3. compare required paths and bundle sizes with the baseline;
4. confirm that the persistent cache is created outside release artifacts;
5. report measured differences without claiming an improvement unsupported by the measurements.

Run the following verification chain:

```text
pnpm test:unit
CI=true pnpm build
pnpm validate:manifest
pnpm validate:vi-assets:release
CI=true pnpm test:e2e
git diff --check
```

Also inspect `dist` directly for required paths, forbidden HTML files, `.DS_Store`, and unexpected manifest changes.

This is a dependency and build-configuration migration, so no permanent source-text assertion will be added. The existing build validators and E2E tests against the unpacked extension are the regression seam.

## Failure Handling

If a semantic Rsbuild option changes the artifact contract, first correct the semantic configuration. Retain a low-level hook only when the supported API cannot reproduce the required MV3 output and document that exception in the implementation result.

If React Compiler causes a compile error or runtime regression, diagnose the incompatible component or hook before deciding whether a narrowly scoped opt-out is justified. Do not silently disable the compiler globally.

If persistent cache produces inconsistent normal and benchmark outputs, expand the cache digest inputs rather than disabling cache without evidence.

## Success Criteria

The migration is complete when:

- exact Rsbuild 2.1 dependencies are installed without duplicate direct Rspack ownership;
- the config uses the selected semantic APIs and contains no `tools.rspack` callback;
- React Compiler and benchmark-aware persistent cache are enabled;
- the MV3 artifact contract and manifest boundary are preserved;
- forbidden files are absent;
- cold and warm measurements are recorded;
- the full verification chain passes.

## References

- [Announcing Rsbuild 2.1](https://rsbuild.rs/blog/v2-1)
- [Announcing Rspack 2.1](https://rspack.rs/blog/announcing-2-1)
- [React plugin](https://rsbuild.rs/plugins/list/plugin-react)
- [`performance.buildCache`](https://rsbuild.rs/config/performance/build-cache)
- [`source.entry`](https://rsbuild.rs/config/source/entry)
- [`output.copy`](https://rsbuild.rs/config/output/copy)
- [`output.filename`](https://rsbuild.rs/config/output/filename)
- [`resolve.conditionNames`](https://rsbuild.rs/config/resolve/condition-names)

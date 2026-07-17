# Rsbuild 2.1 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Chrome extension build to the latest exact Rsbuild 2.1 packages, enable Rust React Compiler and persistent cache, and replace the custom Rspack pipeline with supported Rsbuild configuration while preserving the MV3 artifact contract.

**Architecture:** Rsbuild will own its compatible Rspack version, so the direct `@rspack/core` dependency and all config imports from it will be removed. `rsbuild.config.ts` will use semantic entry, resolve, output, copy, HTML, React Compiler, and cache APIs; existing validators and Playwright will verify the unpacked extension rather than testing configuration source text.

**Tech Stack:** pnpm workspace, Rsbuild 2.1.6, `@rsbuild/plugin-react` 2.1.0, Rspack 2.1.4 transitively, React 19, TypeScript 6, Chrome MV3, Node test runner, Playwright.

## Global Constraints

- Use exact dependency versions: `@rsbuild/core` `2.1.6` and `@rsbuild/plugin-react` `2.1.0`.
- Remove direct `@rspack/core`; Rsbuild 2.1.6 resolves compatible Rspack `~2.1.4`.
- Add no runtime dependency and change no application or backend behavior.
- Keep `splitChunks: false`, `background.js`, `content_script.js`, popup/offscreen HTML paths, manifest permissions, assets, notices, and the verified ONNX Runtime Asyncify pair.
- Enable Rust React Compiler with target React 19.
- Store persistent build cache under `.tmp/rsbuild-cache` and include `READIT_VI_BENCHMARK` in its digest.
- Use `.tmp/rsbuild-2.1-migration` for all measurements and snapshots.
- Do not modify or commit the unrelated `context_improvement.md` file.
- Configuration changes use a one-off red/green contract assertion rather than a permanent source-text test.

---

### Task 1: Capture the Rsbuild 2.0 baseline

**Files:**
- Create at runtime: `.tmp/rsbuild-2.1-migration/baseline-build-time.txt`
- Create at runtime: `.tmp/rsbuild-2.1-migration/baseline.json`
- Inspect: `package.json`
- Inspect: `rsbuild.config.ts`
- Inspect: `dist/`

**Interfaces:**
- Consumes: current pinned Rsbuild 2.0.7, React plugin 2.0.0, and direct Rspack 2.0.4 configuration.
- Produces: baseline build timing, installed versions, file list, and main bundle sizes for the post-migration comparison.

- [ ] **Step 1: Prepare the repository-local measurement directory**

Run:

```bash
mkdir -p .tmp/rsbuild-2.1-migration
```

Expected: `.tmp/rsbuild-2.1-migration` exists and remains ignored by Git.

- [ ] **Step 2: Run and time the baseline production build**

Run:

```bash
/usr/bin/time -p -o .tmp/rsbuild-2.1-migration/baseline-build-time.txt env CI=true pnpm build
```

Expected: exit 0 and `dist/` is rebuilt with Rsbuild 2.0.7.

- [ ] **Step 3: Write the baseline artifact snapshot**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const full=path.join(dir,entry.name); return entry.isDirectory()?walk(full):[full];}); const files=walk("dist").map((file)=>({path:path.relative("dist",file),bytes:fs.statSync(file).size})).sort((a,b)=>a.path.localeCompare(b.path)); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const snapshot={versions:{rsbuild:pkg.devDependencies["@rsbuild/core"],reactPlugin:pkg.devDependencies["@rsbuild/plugin-react"],rspack:pkg.devDependencies["@rspack/core"]},files}; fs.writeFileSync(".tmp/rsbuild-2.1-migration/baseline.json",JSON.stringify(snapshot,null,2)+"\n"); console.log(snapshot.versions, files.length);'
```

Expected: versions are `2.0.7`, `2.0.0`, and `2.0.4`; the JSON lists every baseline artifact and byte size.

- [ ] **Step 4: Confirm the baseline captures the known legacy output behavior**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const snapshot=JSON.parse(fs.readFileSync(".tmp/rsbuild-2.1-migration/baseline.json","utf8")); const paths=snapshot.files.map((file)=>file.path); if(!paths.includes("manifest.json")||!paths.includes("background.js")||!paths.includes("content_script.js")) throw new Error("baseline is missing required extension files"); if(!paths.some((file)=>file.endsWith(".DS_Store"))) throw new Error("baseline no longer reproduces the copy hygiene issue"); console.log("Baseline contract and .DS_Store issue captured");'
```

Expected: prints `Baseline contract and .DS_Store issue captured`.

---

### Task 2: Upgrade dependencies and modernize the build configuration

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `rsbuild.config.ts`
- Verify: `dist/`

**Interfaces:**
- Consumes: baseline snapshot from Task 1 and the approved artifact contract in `_docs/specs/2026-07-16-rsbuild-2-1-migration-design.md`.
- Produces: exact Rsbuild 2.1 dependencies, semantic Rsbuild configuration, React Compiler, benchmark-aware persistent cache, and unchanged required extension paths.

- [ ] **Step 1: Run the one-off contract assertion and verify RED**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const config=fs.readFileSync("rsbuild.config.ts","utf8"); if(pkg.devDependencies["@rsbuild/core"]!=="2.1.6") throw new Error("RED: Rsbuild 2.1.6 is not installed"); if(pkg.devDependencies["@rsbuild/plugin-react"]!=="2.1.0") throw new Error("RED: React plugin 2.1.0 is not installed"); if(pkg.devDependencies["@rspack/core"]) throw new Error("RED: direct Rspack dependency remains"); if(config.includes("tools: {\n\t\trspack")) throw new Error("RED: low-level Rspack config remains");'
```

Expected: fail with `RED: Rsbuild 2.1.6 is not installed`.

- [ ] **Step 2: Install exact Rsbuild 2.1 packages**

Run:

```bash
pnpm add -D --save-exact @rsbuild/core@2.1.6 @rsbuild/plugin-react@2.1.0
```

Expected: `package.json` and `pnpm-lock.yaml` resolve Rsbuild core 2.1.6, React plugin 2.1.0, and compatible Rspack 2.1.4.

- [ ] **Step 3: Remove direct Rspack ownership**

Run:

```bash
pnpm remove -D @rspack/core
```

Expected: `@rspack/core` disappears from root `devDependencies`; the lockfile retains the transitive version required by Rsbuild.

- [ ] **Step 4: Replace `rsbuild.config.ts` with semantic Rsbuild configuration**

Use this complete configuration:

```ts
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const vietnameseBenchmark = process.env.READIT_VI_BENCHMARK === '1';

export default defineConfig({
	// Manifest-injected scripts have no HTML loader for async chunks.
	splitChunks: false,
	plugins: [
		pluginReact({
			reactCompiler: {
				target: '19',
			},
		}),
	],
	performance: {
		buildCache: {
			cacheDirectory: '.tmp/rsbuild-cache',
			cacheDigest: [process.env.READIT_VI_BENCHMARK],
		},
	},
	resolve: {
		conditionNames: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
	},
	source: {
		entry: {
			popup: './src/popup/index.tsx',
			offscreen: vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.ts' : './src/offscreen/offscreen.ts',
			background: {
				import: './src/background/background.ts',
				html: false,
			},
			content_script: {
				import: './src/content/content_script.ts',
				html: false,
			},
		},
	},
	dev: {
		writeToDisk: true,
	},
	server: {
		publicDir: {
			copyOnBuild: false,
		},
	},
	output: {
		distPath: {
			root: vietnameseBenchmark ? '.tmp/vietnamese-performance/extension' : 'dist',
			js: '',
		},
		assetPrefix: '/',
		cleanDistPath: true,
		filename: {
			js: (pathData) => {
				if (pathData.chunk?.name === 'background' || pathData.chunk?.name === 'content_script') {
					return '[name].js';
				}
				return 'assets/[name].[contenthash:8].js';
			},
		},
		copy: [
			{
				from: 'public',
				to: '.',
				globOptions: {
					ignore: ['**/.DS_Store'],
				},
			},
			{
				from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
				to: 'ort-wasm-simd-threaded.asyncify.wasm',
			},
			{
				from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
				to: 'ort-wasm-simd-threaded.asyncify.mjs',
			},
		],
	},
	html: {
		template({ entryName }) {
			if (entryName === 'popup') {
				return './src/popup/popup.html';
			}
			if (entryName === 'offscreen') {
				return vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.html' : './src/offscreen/offscreen.html';
			}
			return './src/popup/popup.html';
		},
	},
	tools: {
		htmlPlugin(config, { entryName }) {
			if (entryName === 'popup') {
				config.filename = 'src/popup/popup.html';
			} else if (entryName === 'offscreen') {
				config.filename = 'src/offscreen/offscreen.html';
			}
		},
	},
});
```

- [ ] **Step 5: Re-run the contract assertion and verify GREEN**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const config=fs.readFileSync("rsbuild.config.ts","utf8"); if(pkg.devDependencies["@rsbuild/core"]!=="2.1.6") throw new Error("Rsbuild version mismatch"); if(pkg.devDependencies["@rsbuild/plugin-react"]!=="2.1.0") throw new Error("React plugin version mismatch"); if(pkg.devDependencies["@rspack/core"]) throw new Error("direct Rspack dependency remains"); if(config.includes("tools: {\n\t\trspack")||config.includes("CopyRspackPlugin")||config.includes("RemoveHtmlPlugin")) throw new Error("low-level Rspack config remains"); console.log("Dependency and config contract passed");'
```

Expected: prints `Dependency and config contract passed`.

- [ ] **Step 6: Build with the migrated configuration**

Run:

```bash
CI=true pnpm build
```

Expected: TypeScript and Rsbuild complete with exit 0, with no deprecation or React Compiler errors.

- [ ] **Step 7: Assert the MV3 artifact layout**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const required=["manifest.json","background.js","content_script.js","src/popup/popup.html","src/offscreen/offscreen.html","THIRD_PARTY_NOTICES.txt","ort-wasm-simd-threaded.asyncify.mjs","ort-wasm-simd-threaded.asyncify.wasm"]; for(const file of required){if(!fs.existsSync(path.join("dist",file))) throw new Error(`missing ${file}`);} const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const full=path.join(dir,entry.name); return entry.isDirectory()?walk(full):[full];}); const paths=walk("dist").map((file)=>path.relative("dist",file)); for(const forbidden of ["background.html","content_script.html"]){if(paths.includes(forbidden)) throw new Error(`forbidden ${forbidden}`);} if(paths.some((file)=>path.basename(file)===".DS_Store")) throw new Error("forbidden .DS_Store"); console.log(`Artifact contract passed (${paths.length} files)`);'
```

Expected: required paths exist; no generated background/content-script HTML or `.DS_Store` remains.

- [ ] **Step 8: Run focused build validators**

Run:

```bash
pnpm validate:manifest
pnpm validate:vi-assets:release
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit the dependency and configuration migration**

Run:

```bash
git add package.json pnpm-lock.yaml rsbuild.config.ts
git commit -m "build: migrate to Rsbuild 2.1"
```

Expected: one commit containing only the dependency lockstep upgrade and build configuration modernization.

---

### Task 3: Measure cache behavior and run full extension verification

**Files:**
- Create at runtime: `.tmp/rsbuild-2.1-migration/cold-build-time.txt`
- Create at runtime: `.tmp/rsbuild-2.1-migration/warm-build-time.txt`
- Create at runtime: `.tmp/rsbuild-2.1-migration/migrated.json`
- Verify: `dist/`
- Verify: `.tmp/rsbuild-cache/`

**Interfaces:**
- Consumes: migrated build from Task 2 and baseline snapshot from Task 1.
- Produces: measured cold/warm build evidence, artifact size comparison, and full runtime verification results.

- [ ] **Step 1: Clear only the repository-local Rsbuild cache**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; fs.rmSync(".tmp/rsbuild-cache",{recursive:true,force:true});'
```

Expected: `.tmp/rsbuild-cache` is absent before the cold build; no source or release file is removed.

- [ ] **Step 2: Measure a cold migrated build**

Run:

```bash
/usr/bin/time -p -o .tmp/rsbuild-2.1-migration/cold-build-time.txt env CI=true pnpm build
```

Expected: exit 0 and `.tmp/rsbuild-cache` is created.

- [ ] **Step 3: Measure a warm migrated build**

Run:

```bash
/usr/bin/time -p -o .tmp/rsbuild-2.1-migration/warm-build-time.txt env CI=true pnpm build
```

Expected: exit 0 using the existing persistent cache.

- [ ] **Step 4: Capture the migrated artifact snapshot**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const full=path.join(dir,entry.name); return entry.isDirectory()?walk(full):[full];}); const files=walk("dist").map((file)=>({path:path.relative("dist",file),bytes:fs.statSync(file).size})).sort((a,b)=>a.path.localeCompare(b.path)); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const lock=fs.readFileSync("pnpm-lock.yaml","utf8"); const rspack=lock.match(/'@rspack\/core@([^':]+)':/)?.[1] ?? "not-found"; const snapshot={versions:{rsbuild:pkg.devDependencies["@rsbuild/core"],reactPlugin:pkg.devDependencies["@rsbuild/plugin-react"],rspack},files}; fs.writeFileSync(".tmp/rsbuild-2.1-migration/migrated.json",JSON.stringify(snapshot,null,2)+"\n"); console.log(snapshot.versions, files.length);'
```

Expected: reports Rsbuild 2.1.6, React plugin 2.1.0, and Rspack 2.1.4.

- [ ] **Step 5: Print the measured timing and bundle-size comparison**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const baseline=JSON.parse(fs.readFileSync(".tmp/rsbuild-2.1-migration/baseline.json","utf8")); const migrated=JSON.parse(fs.readFileSync(".tmp/rsbuild-2.1-migration/migrated.json","utf8")); const select=(snapshot)=>Object.fromEntries(snapshot.files.filter((file)=>/^(background|content_script)\.js$|^assets\/(popup|offscreen)\..*\.js$|^static\/css\/popup\..*\.css$/.test(file.path)).map((file)=>[file.path,file.bytes])); console.log({baselineTime:fs.readFileSync(".tmp/rsbuild-2.1-migration/baseline-build-time.txt","utf8").trim(),coldTime:fs.readFileSync(".tmp/rsbuild-2.1-migration/cold-build-time.txt","utf8").trim(),warmTime:fs.readFileSync(".tmp/rsbuild-2.1-migration/warm-build-time.txt","utf8").trim(),baselineBundles:select(baseline),migratedBundles:select(migrated)});'
```

Expected: prints factual baseline, cold, warm, and bundle-size values. Treat lower times or sizes as improvements only when the printed values support that claim.

- [ ] **Step 6: Run all unit tests**

Run:

```bash
pnpm test:unit
```

Expected: all Node unit tests pass with zero failures.

- [ ] **Step 7: Rebuild and validate the release boundary**

Run:

```bash
CI=true pnpm build
pnpm validate:manifest
pnpm validate:vi-assets:release
```

Expected: all commands exit 0 against the final `dist` output.

- [ ] **Step 8: Run the full E2E suite against the unpacked extension**

Run:

```bash
CI=true pnpm test:e2e
```

Expected: all Playwright tests pass using the built MV3 extension.

- [ ] **Step 9: Run final repository checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the intentionally untracked `context_improvement.md` may remain outside committed migration work.

- [ ] **Step 10: Report migration evidence**

Report:

```text
- exact Rsbuild, React plugin, and transitive Rspack versions;
- removed direct Rspack dependency and low-level hooks;
- React Compiler and cache configuration;
- baseline, cold, and warm build times;
- before/after main bundle sizes;
- artifact contract and validator results;
- unit and E2E pass counts;
- any retained low-level exception (expected: none).
```

Expected: every completion claim is backed by output from the preceding steps.

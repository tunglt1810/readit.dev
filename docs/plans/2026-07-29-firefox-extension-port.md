# Firefox Extension Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable building and publishing Readit.dev as a Firefox Manifest V3 Extension alongside Chrome from a single codebase, including automated Rsbuild manifest transformations and complete CI/CD release pipeline updates.

**Architecture:** Use `webextension-polyfill` for cross-browser API abstraction (`browser.*`), configure Rsbuild with `TARGET_BROWSER=chrome|firefox` to output browser-specific manifest structures (`dist/chrome` and `dist/firefox`), update validation scripts, and extend GitHub Actions workflow for AMO release.

**Tech Stack:** TypeScript, React 19, Rsbuild, `webextension-polyfill`, Node.js test runner, Playwright, GitHub Actions.

## Global Constraints
- Do not introduce breaking changes to the Chrome extension build.
- Follow existing Biome formatting (tabs for indentation, 140 character line width).
- Save plans in `docs/plans/`.
- Executed in git worktree `.worktrees/firefox-port` on branch `feat/firefox-port`.

---

### Task 1: Add `webextension-polyfill` and Browser Abstraction Module

**Files:**
- Modify: `package.json`
- Create: `src/shared/browser.ts`
- Create: `tests/unit/browser_abstraction.test.ts`

**Interfaces:**
- Consumes: `webextension-polyfill`
- Produces: `browser` export and `openSidebarOrPanel(tabId?: number): Promise<void>` helper in `src/shared/browser.ts`.

- [ ] **Step 1: Install `webextension-polyfill` and its types**

Run: `pnpm add webextension-polyfill && pnpm add -D @types/webextension-polyfill`

- [ ] **Step 2: Create unit test for browser abstraction helper**

Write `tests/unit/browser_abstraction.test.ts`:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('openSidebarOrPanel calls sidebarAction when available', async () => {
	let sidebarOpened = false;
	const mockBrowser = {
		sidebarAction: {
			open: async () => {
				sidebarOpened = true;
			},
		},
	};
	if (mockBrowser.sidebarAction) {
		await mockBrowser.sidebarAction.open();
	}
	assert.equal(sidebarOpened, true);
});
```

- [ ] **Step 3: Run unit test to verify**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 4: Create `src/shared/browser.ts`**

Write `src/shared/browser.ts`:
```typescript
import browser from 'webextension-polyfill';

export default browser;

export async function openSidebarOrPanel(tabId?: number): Promise<void> {
	// Firefox sidebarAction support
	const anyBrowser = browser as unknown as {
		sidebarAction?: { open: () => Promise<void> };
		sidePanel?: { open: (options: { tabId?: number }) => Promise<void> };
	};

	if (anyBrowser.sidebarAction?.open) {
		await anyBrowser.sidebarAction.open();
	} else if (anyBrowser.sidePanel?.open) {
		await anyBrowser.sidePanel.open({ tabId });
	}
}
```

- [ ] **Step 5: Commit**

Run: `git add package.json pnpm-lock.yaml src/shared/browser.ts tests/unit/browser_abstraction.test.ts`
Run: `git commit -m "feat: add webextension-polyfill and browser abstraction helper"`

---

### Task 2: Configure Rsbuild Multi-Target Build and Manifest Transformation

**Files:**
- Modify: `rsbuild.config.ts`

**Interfaces:**
- Consumes: Environment variable `TARGET_BROWSER` (`chrome` | `firefox`, default `chrome`).
- Produces: `dist/chrome` (or `dist`) for Chrome, `dist/firefox` for Firefox with converted manifest.

- [ ] **Step 1: Update `rsbuild.config.ts` for dual browser build**

Modify `rsbuild.config.ts`:
```typescript
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const targetBrowser = process.env.TARGET_BROWSER || 'chrome';
const vietnameseBenchmark = process.env.READIT_VI_BENCHMARK === '1';
const appVersion = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf-8')).version as string;
const buildVersion = process.env.BUILD_NUMBER ? `${appVersion}-dev.${process.env.BUILD_NUMBER}` : appVersion;

const distDir = vietnameseBenchmark
	? '.tmp/vietnamese-performance/extension'
	: targetBrowser === 'firefox'
		? 'dist/firefox'
		: 'dist/chrome';

export default defineConfig({
	splitChunks: false,
	plugins: [
		pluginReact({
			reactCompiler: { target: '19' },
		}),
		{
			name: 'manifest-transform-plugin',
			setup(api) {
				const transformManifest = () => {
					const manifestPath = path.join(api.context.distPath, 'manifest.json');
					if (!fs.existsSync(manifestPath)) return;

					const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
					const packageJsonPath = path.resolve(api.context.rootPath, 'package.json');
					const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
					manifest.version = packageJson.version;

					if (targetBrowser === 'firefox') {
						delete manifest.minimum_chrome_version;
						manifest.background = {
							scripts: ['background.js'],
						};
						if (manifest.side_panel) {
							manifest.sidebar_action = {
								default_panel: manifest.side_panel.default_path,
								default_title: 'readit.dev',
								default_icon: manifest.action?.default_icon || {
									'16': 'assets/icon16.png',
									'32': 'assets/icon32.png',
									'48': 'assets/icon48.png',
									'128': 'assets/icon128.png',
								},
							};
							delete manifest.side_panel;
						}
						if (manifest.commands?.open_side_panel) {
							manifest.commands._execute_sidebar_action = manifest.commands.open_side_panel;
							delete manifest.commands.open_side_panel;
						}
						manifest.browser_specific_settings = {
							gecko: {
								id: 'readit-dev@readit.dev',
								strict_min_version: '115.0',
							},
						};
					}

					fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t'));
				};
				api.onAfterBuild(transformManifest);
				api.onDevCompileDone(transformManifest);
			},
		},
	],
	performance: {
		buildCache: {
			cacheDirectory: `.tmp/rsbuild-cache-${targetBrowser}`,
			cacheDigest: [process.env.READIT_VI_BENCHMARK, targetBrowser],
		},
	},
	resolve: {
		conditionNames: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
	},
	source: {
		define: {
			__BUILD_VERSION__: JSON.stringify(buildVersion),
			__TARGET_BROWSER__: JSON.stringify(targetBrowser),
		},
		entry: {
			popup: './src/popup/index.tsx',
			sidepanel: './src/sidepanel/index.tsx',
			reader: './src/reader/index.tsx',
			offscreen: vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.ts' : './src/offscreen/offscreen.ts',
			background: { import: './src/background/background.ts', html: false },
			content_script: { import: './src/content/content_script.ts', html: false },
		},
	},
	dev: { writeToDisk: true },
	output: {
		distPath: { root: distDir, js: '' },
		assetPrefix: '/',
		cleanDistPath: true,
		filename: {
			js: (pathData) => (pathData.chunk?.name === 'background' || pathData.chunk?.name === 'content_script' ? '[name].js' : 'assets/[name].[contenthash:8].js'),
		},
		copy: [
			{ from: 'public', to: '.', globOptions: { ignore: ['**/.DS_Store'] } },
			{ from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', to: 'ort-wasm-simd-threaded.asyncify.wasm' },
			{ from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', to: 'ort-wasm-simd-threaded.asyncify.mjs' },
		],
	},
	html: {
		template({ entryName }) {
			if (entryName === 'popup') return './src/popup/popup.html';
			if (entryName === 'sidepanel') return './src/sidepanel/sidepanel.html';
			if (entryName === 'reader') return './src/reader/reader.html';
			if (entryName === 'offscreen') return vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.html' : './src/offscreen/offscreen.html';
			return './src/popup/popup.html';
		},
	},
	tools: {
		htmlPlugin(config, { entryName }) {
			if (entryName === 'popup') config.filename = 'src/popup/popup.html';
			else if (entryName === 'sidepanel') config.filename = 'src/sidepanel/sidepanel.html';
			else if (entryName === 'reader') config.filename = 'src/reader/reader.html';
			else if (entryName === 'offscreen') config.filename = 'src/offscreen/offscreen.html';
		},
	},
});
```

- [ ] **Step 2: Test building for Chrome and Firefox targets**

Run: `TARGET_BROWSER=chrome pnpm exec rsbuild build && TARGET_BROWSER=firefox pnpm exec rsbuild build`
Expected: Outputs `dist/chrome/manifest.json` with `side_panel` and `dist/firefox/manifest.json` with `sidebar_action` and `gecko.id`.

- [ ] **Step 3: Commit**

Run: `git add rsbuild.config.ts`
Run: `git commit -m "feat: configure Rsbuild for dual Chrome and Firefox target builds"`

---

### Task 3: Refactor Chrome API Calls to Polyfill Abstraction in Extension Core

**Files:**
- Modify: `src/background/background.ts`

- [ ] **Step 1: Replace `chrome.*` references with `browser` in `src/background/background.ts`**

Import `browser, { openSidebarOrPanel }` from `../shared/browser.js` and replace calls:
- `chrome.runtime` -> `browser.runtime`
- `chrome.storage.session` -> `browser.storage.session`
- `chrome.storage.local` -> `browser.storage.local`
- `chrome.tabs` -> `browser.tabs`
- `chrome.offscreen` -> `browser.offscreen`

- [ ] **Step 2: Verify unit tests pass**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add src/background/background.ts`
Run: `git commit -m "refactor: use browser polyfill abstraction in background script"`

---

### Task 4: Update Build & Validation Scripts in `package.json` and `scripts/`

**Files:**
- Modify: `package.json`
- Modify: `scripts/validate-free-manifest.mjs`
- Modify: `scripts/validate-extension-archive.mjs`

- [ ] **Step 1: Update `scripts/validate-free-manifest.mjs` for `--target` support**

Update `scripts/validate-free-manifest.mjs` to accept `--target chrome|firefox` and validate Firefox-specific keys (`gecko.id`, `sidebar_action`) or Chrome-specific keys accordingly.

- [ ] **Step 2: Update `package.json` build and validation scripts**

Update `package.json` `scripts`:
```json
"build:chrome": "TARGET_BROWSER=chrome tsc && TARGET_BROWSER=chrome rsbuild build",
"build:firefox": "TARGET_BROWSER=firefox tsc && TARGET_BROWSER=firefox rsbuild build",
"build": "pnpm build:chrome && pnpm build:firefox",
"validate:manifest:chrome": "node scripts/validate-free-manifest.mjs dist/chrome/manifest.json --target chrome",
"validate:manifest:firefox": "node scripts/validate-free-manifest.mjs dist/firefox/manifest.json --target firefox"
```

- [ ] **Step 3: Verify script validation**

Run: `pnpm build && pnpm validate:manifest:chrome && pnpm validate:manifest:firefox`
Expected: Successful build and validation for both dist targets.

- [ ] **Step 4: Commit**

Run: `git add package.json scripts/validate-free-manifest.mjs`
Run: `git commit -m "feat: add multi-target validation scripts to package.json"`

---

### Task 5: Update GitHub Actions Release Pipeline for Firefox AMO Release

**Files:**
- Modify: `.github/workflows/release-extension.yml`

- [ ] **Step 1: Update `.github/workflows/release-extension.yml`**

Add steps to:
1. Build both targets: `pnpm build:chrome` and `pnpm build:firefox`.
2. Package Firefox zip: `readit.dev-firefox-${RELEASE_VERSION}.zip` from `dist/firefox`.
3. Upload both Chrome and Firefox zip packages to GitHub Release.
4. Add AMO submission step using `wext-ship` or Mozilla `web-ext` action / cURL API submission.

- [ ] **Step 2: Commit**

Run: `git add .github/workflows/release-extension.yml`
Run: `git commit -m "ci: update release workflow for dual Chrome Web Store and Firefox AMO deployment"`

---

### Task 6: Final Verification & Integration Checklist

- [ ] **Step 1: Run full unit test suite**

Run: `pnpm test:unit`
Expected: 307+ tests passing.

- [ ] **Step 2: Run full build and manifest validation**

Run: `pnpm build && pnpm validate:manifest:chrome && pnpm validate:manifest:firefox`
Expected: Both `dist/chrome` and `dist/firefox` built and validated without errors.

- [ ] **Step 3: Commit all remaining work**

Run: `git status`
Expected: Clean working tree on `feat/firefox-port`.

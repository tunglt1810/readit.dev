import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

import fs from 'node:fs';
import path from 'node:path';

const vietnameseBenchmark = process.env.READIT_VI_BENCHMARK === '1';
const targetBrowser = process.env.TARGET_BROWSER ?? 'chrome';
const appVersion = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf-8')).version as string;
const buildVersion = process.env.BUILD_NUMBER ? `${appVersion}-dev.${process.env.BUILD_NUMBER}` : appVersion;

export default defineConfig({
	// Manifest-injected scripts have no HTML loader for async chunks.
	splitChunks: false,
	plugins: [
		pluginReact({
			reactCompiler: {
				target: '19',
			},
		}),
		{
			name: 'manifest-version-and-browser-transform',
			setup(api) {
				const syncAndTransformManifest = () => {
					const distPath = api.context.distPath;
					const manifestPath = path.join(distPath, 'manifest.json');
					if (fs.existsSync(manifestPath)) {
						const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
						const packageJsonPath = path.resolve(api.context.rootPath, 'package.json');
						const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
						manifest.version = packageJson.version;
						if (process.env.BUILD_NUMBER) {
							manifest.version_name = `${packageJson.version}-dev.${process.env.BUILD_NUMBER}`;
						}

						if (targetBrowser === 'firefox') {
							delete manifest.minimum_chrome_version;
							manifest.background = {
								scripts: ['background.js'],
							};
							if (Array.isArray(manifest.permissions)) {
								manifest.permissions = manifest.permissions.filter(
									(permission: string) => permission !== 'sidePanel' && permission !== 'offscreen',
								);
								if (!manifest.permissions.includes('downloads')) {
									manifest.permissions.push('downloads');
								}
							}
							if (Array.isArray(manifest.host_permissions)) {
								manifest.host_permissions = manifest.host_permissions.filter(
									(permission: string) => permission !== 'file://*/*',
								);
							}
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
									data_collection_permissions: {
										required: ['none'],
									},
								},
							};
						}

						fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t'));
					}
				};
				api.onAfterBuild(syncAndTransformManifest);
				api.onDevCompileDone(syncAndTransformManifest);
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
		},
		entry: {
			popup: './src/popup/index.tsx',
			sidepanel: './src/sidepanel/index.tsx',
			reader: './src/reader/index.tsx',
			settings: './src/settings/index.tsx',
			offscreen: vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.ts' : './src/offscreen/offscreen_entry.ts',
			background: {
				import: targetBrowser === 'firefox' ? './src/background/firefox_background.ts' : './src/background/background.ts',
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
			root: vietnameseBenchmark ? '.tmp/vietnamese-performance/extension' : `dist/${targetBrowser}`,
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
			if (entryName === 'sidepanel') {
				return './src/sidepanel/sidepanel.html';
			}
			if (entryName === 'reader') {
				return './src/reader/reader.html';
			}
			if (entryName === 'settings') {
				return './src/settings/settings.html';
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
			} else if (entryName === 'sidepanel') {
				config.filename = 'src/sidepanel/sidepanel.html';
			} else if (entryName === 'reader') {
				config.filename = 'src/reader/reader.html';
			} else if (entryName === 'settings') {
				config.filename = 'src/settings/settings.html';
			} else if (entryName === 'offscreen') {
				config.filename = 'src/offscreen/offscreen.html';
			}
		},
	},
});

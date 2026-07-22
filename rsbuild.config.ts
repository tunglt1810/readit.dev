import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

import fs from 'node:fs';
import path from 'node:path';

const vietnameseBenchmark = process.env.READIT_VI_BENCHMARK === '1';
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
			name: 'manifest-version-sync',
			setup(api) {
				const syncVersion = () => {
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
						fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t'));
					}
				};
				api.onAfterBuild(syncVersion);
				api.onDevCompileDone(syncVersion);
			},
		},
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
		define: {
			__BUILD_VERSION__: JSON.stringify(buildVersion),
		},
		entry: {
			popup: './src/popup/index.tsx',
			sidepanel: './src/sidepanel/index.tsx',
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
			if (entryName === 'sidepanel') {
				return './src/sidepanel/sidepanel.html';
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
			} else if (entryName === 'offscreen') {
				config.filename = 'src/offscreen/offscreen.html';
			}
		},
	},
});

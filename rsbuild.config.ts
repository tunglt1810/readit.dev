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

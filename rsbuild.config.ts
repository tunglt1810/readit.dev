import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { Compiler, CopyRspackPlugin } from '@rspack/core';

const vietnameseBenchmark = process.env.READIT_VI_BENCHMARK === '1';

export default defineConfig({
	// Manifest-injected scripts have no HTML loader for async chunks.
	splitChunks: false,
	plugins: [pluginReact()],
	source: {
		entry: {
			popup: './src/popup/index.tsx',
			offscreen: vietnameseBenchmark ? './tests/performance/vietnamese_offscreen_benchmark.ts' : './src/offscreen/offscreen.ts',
			background: './src/background/background.ts',
			content_script: './src/content/content_script.ts',
		},
	},
	dev: {
		writeToDisk: true,
	},
	output: {
		distPath: {
			root: vietnameseBenchmark ? '.tmp/vietnamese-performance/extension' : 'dist',
		},
		assetPrefix: '/',
		cleanDistPath: true,
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
		rspack: (config) => {
			config.resolve = {
				...config.resolve,
				conditionNames: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
			};
			// Đảm bảo background.js và content_script.js nằm ở root không bị hash
			config.output = {
				...config.output,
				filename: (pathData) => {
					if (pathData.chunk?.name === 'background' || pathData.chunk?.name === 'content_script') {
						return '[name].js';
					}
					return 'assets/[name].[contenthash:8].js';
				},
			};

			config.plugins = config.plugins || [];

			// Điều chỉnh tên file HTML đầu ra cho đúng thư mục của Extension
			config.plugins.forEach((plugin: unknown) => {
				if (plugin && typeof plugin === 'object' && plugin.constructor.name === 'HtmlRspackPlugin') {
					const htmlPlugin = plugin as { userOptions?: Record<string, unknown>; options?: Record<string, unknown> };
					const options = htmlPlugin.userOptions || htmlPlugin.options || {};
					const chunks = options.chunks as string[] | undefined;
					if (chunks?.includes('popup')) {
						options.filename = 'src/popup/popup.html';
					} else if (chunks?.includes('offscreen')) {
						options.filename = 'src/offscreen/offscreen.html';
					}
				}
			});

			// Copy the extension package and the single verified ONNX Runtime Asyncify pair.
			config.plugins.push(
				new CopyRspackPlugin({
					patterns: [
						{
							from: 'public/manifest.json',
							to: 'manifest.json',
						},
						{
							from: 'public/THIRD_PARTY_NOTICES.txt',
							to: 'THIRD_PARTY_NOTICES.txt',
						},
						{
							from: 'public/assets',
							to: 'assets',
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
				}),
			);

			// Xóa các file HTML rác được sinh ra cho background và content_script
			config.plugins.push({
				name: 'RemoveHtmlPlugin',
				apply(compiler: Compiler) {
					compiler.hooks.emit.tap('RemoveHtmlPlugin', (compilation) => {
						delete compilation.assets['background.html'];
						delete compilation.assets['content_script.html'];
					});
				},
			});

			return config;
		},
	},
});

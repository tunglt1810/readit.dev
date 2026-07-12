import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { CopyRspackPlugin } from '@rspack/core';

export default defineConfig({
	// Manifest-injected scripts have no HTML loader for async chunks.
	splitChunks: false,
	plugins: [pluginReact()],
	source: {
		entry: {
			popup: './src/popup/index.tsx',
			offscreen: './src/offscreen/offscreen.ts',
			background: './src/background/background.ts',
			content_script: './src/content/content_script.ts',
		},
	},
	dev: {
		writeToDisk: true,
	},
	output: {
		distPath: {
			root: 'dist',
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
				return './src/offscreen/offscreen.html';
			}
			return './src/popup/popup.html';
		},
		filename({ entryName }) {
			if (entryName === 'popup') {
				return 'src/popup/popup.html';
			}
			if (entryName === 'offscreen') {
				return 'src/offscreen/offscreen.html';
			}
			return '[name].html';
		},
	},
	tools: {
		rspack: (config) => {
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
			config.plugins.forEach((plugin: any) => {
				if (plugin.constructor.name === 'HtmlRspackPlugin') {
					const options = plugin.userOptions || plugin.options || {};
					if (options.chunks && options.chunks.includes('popup')) {
						options.filename = 'src/popup/popup.html';
					} else if (options.chunks && options.chunks.includes('offscreen')) {
						options.filename = 'src/offscreen/offscreen.html';
					}
				}
			});

			// Thêm CopyRspackPlugin để copy manifest.json, assets, WASM và MJS từ node_modules trực tiếp vào dist
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
							from: 'node_modules/onnxruntime-web/dist/*.wasm',
							to: '[name][ext]',
						},
						{
							from: 'node_modules/onnxruntime-web/dist/*.mjs',
							to: '[name][ext]',
						},
					],
				}),
			);

			// Xóa các file HTML rác được sinh ra cho background và content_script
			config.plugins.push({
				name: 'RemoveHtmlPlugin',
				apply(compiler) {
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

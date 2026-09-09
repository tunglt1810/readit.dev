import * as ort from 'onnxruntime-web/webgpu';

/**
 * The single place that configures ONNX Runtime, because there is a single runtime.
 *
 * `ort.env` is one shared object for the whole document. The speech engine and the Vietnamese
 * abbreviation scorer each used to set `env.wasm` at their own module scope, so whichever module
 * happened to evaluate last decided the settings for both — which is how `proxy` stayed false no
 * matter what the speech engine asked for. Configuring it here, once, and re-exporting the runtime
 * makes that collision impossible to reintroduce.
 */

// The two artifacts the build copies to the extension root (see rsbuild.config.ts). Naming them
// outright rather than handing ORT a prefix keeps the proxy worker, which resolves them from its
// own scope, pointed at the same files this document loads.
ort.env.wasm.wasmPaths =
	typeof chrome !== 'undefined' && chrome.runtime
		? {
				mjs: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.mjs'),
				wasm: chrome.runtime.getURL('ort-wasm-simd-threaded.asyncify.wasm'),
			}
		: '/';

// Multi-threading needs cross-origin isolation, which an extension page does not have.
ort.env.wasm.numThreads = 1;

/**
 * Inference runs in a worker, not on the document that owns playback.
 *
 * WASM inference is synchronous, so on the main thread it blocks everything the offscreen document
 * owns for its whole duration: the word-highlight interval, the `onended` that starts the next
 * unit, and the progress reports every surface reads its state from. Measured on a five-unit
 * article, that was 62% of a 30-second window with the highlight visibly frozen; with the worker it
 * is under 2%.
 *
 * The cost is that ORT transfers an input tensor's ArrayBuffer to the worker and leaves it detached
 * here, so an input used by more than one run has to be handed over as its own copy — see
 * `copyTensor` in supertonic_helper.ts.
 */
ort.env.wasm.proxy = true;

export * from 'onnxruntime-web/webgpu';

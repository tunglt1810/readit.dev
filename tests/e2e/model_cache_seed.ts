import path from 'path';

/** Chrome profile directory that holds a pre-warmed Supertonic model Cache Storage. */
export const MODEL_CACHE_SEED_DIR = path.join(process.cwd(), '.tmp', 'e2e-model-cache-seed');

/** Marker written after a successful seed; its content pins the exact model URLs it covers. */
export const MODEL_CACHE_SEED_MARKER = path.join(MODEL_CACHE_SEED_DIR, '.seed-complete.json');

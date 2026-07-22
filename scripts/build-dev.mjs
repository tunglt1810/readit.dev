#!/usr/bin/env node
// Script for local dev builds: auto-increments .build-number and passes it to rsbuild.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const buildNumberFile = resolve(import.meta.dirname, '../.build-number');

const current = existsSync(buildNumberFile) ? parseInt(readFileSync(buildNumberFile, 'utf-8').trim(), 10) : 0;
const next = current + 1;

writeFileSync(buildNumberFile, String(next));
console.log(`build-dev: build number → ${next}`);

execSync('rsbuild build', {
	stdio: 'inherit',
	env: { ...process.env, BUILD_NUMBER: String(next) },
});

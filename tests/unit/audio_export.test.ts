import assert from 'node:assert/strict';
import test from 'node:test';
import {
	AUDIO_EXPORT_BITRATE_BPS,
	LONG_AUDIO_EXPORT_SECONDS,
	MP3_CONTAINER_OVERHEAD_BYTES,
	createAudioExportEstimate,
	isAudioExportActive,
	isAudioExportEstimate,
	isAudioExportJobSnapshot,
	requiresLongAudioExportConfirmation,
	sanitizeMp3Filename,
	suggestAudioExportFilename,
} from '../../src/shared/audio_export.ts';
import type { AudioExportJobSnapshot, PlaybackSessionSnapshot } from '../../src/shared/types.ts';

const articleSession: PlaybackSessionSnapshot = {
	sessionId: 'article-session',
	contentScope: 'article',
	source: { kind: 'tab', tabId: 1, title: 'An article', url: 'https://example.com/article' },
	readableSurface: 'website-dom',
	lang: 'en',
	status: 'playing',
	currentParagraphIndex: 1,
	totalParagraphs: 2,
	progressPercentage: 50,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1,
};

const selectionSession: PlaybackSessionSnapshot = {
	...articleSession,
	sessionId: 'selection-session',
	contentScope: 'selection',
};

const manualSession: PlaybackSessionSnapshot = {
	sessionId: 'manual-session',
	contentScope: 'manual',
	source: { kind: 'manual', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' },
	readableSurface: 'manual-reader',
	lang: 'vi',
	status: 'playing',
	currentParagraphIndex: 1,
	totalParagraphs: 2,
	progressPercentage: 50,
	voiceStyleId: 'F1',
	speed: 1.05,
	updatedAt: 1,
};

const validJob: AudioExportJobSnapshot = {
	jobId: 'export-1',
	playbackSessionId: articleSession.sessionId,
	title: 'An article',
	outputFilename: 'An article.mp3',
	state: 'exporting',
	estimate: { durationSeconds: 10, estimatedBytes: 124_096 },
	processedDurationSeconds: 5,
	progressPercentage: 50,
	bytesWritten: 60_000,
	etaSeconds: 5,
	startedAt: 1_000,
	updatedAt: 2_000,
};

test('estimates a 60 minute 96 kbps MP3 without a hard cap', () => {
	assert.equal(AUDIO_EXPORT_BITRATE_BPS, 96_000);
	assert.equal(LONG_AUDIO_EXPORT_SECONDS, 60 * 60);
	assert.equal(MP3_CONTAINER_OVERHEAD_BYTES, 4_096);
	assert.deepEqual(createAudioExportEstimate(3600), {
		durationSeconds: 3600,
		estimatedBytes: 43_200_000 + MP3_CONTAINER_OVERHEAD_BYTES,
	});
	assert.equal(requiresLongAudioExportConfirmation(createAudioExportEstimate(3600)), true);
	assert.equal(requiresLongAudioExportConfirmation(createAudioExportEstimate(3599.99)), false);
});

test('accepts only finite non-negative export estimates', () => {
	assert.equal(isAudioExportEstimate({ durationSeconds: 0, estimatedBytes: 0 }), true);
	assert.equal(isAudioExportEstimate({ durationSeconds: -1, estimatedBytes: 0 }), false);
	assert.equal(isAudioExportEstimate({ durationSeconds: 1, estimatedBytes: Number.NaN }), false);
	assert.equal(isAudioExportEstimate({ durationSeconds: 1, estimatedBytes: 2, extra: true }), false);
});

test('accepts only complete bounded audio export job snapshots', () => {
	assert.equal(isAudioExportJobSnapshot(validJob), true);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, state: 'queued' }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, errorCode: 'other' }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, progressPercentage: 101 }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, processedDurationSeconds: 11 }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, bytesWritten: -1 }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, updatedAt: Number.POSITIVE_INFINITY }), false);
	assert.equal(isAudioExportJobSnapshot({ ...validJob, extra: true }), false);
});

test('identifies only nonterminal audio export jobs as active', () => {
	assert.equal(isAudioExportActive(validJob), true);
	assert.equal(isAudioExportActive({ ...validJob, state: 'completed' }), false);
	assert.equal(isAudioExportActive({ ...validJob, state: 'failed' }), false);
	assert.equal(isAudioExportActive({ ...validJob, state: 'interrupted' }), false);
	assert.equal(isAudioExportActive(null), false);
});

test('creates source-specific safe filenames', () => {
	assert.equal(suggestAudioExportFilename(articleSession, new Date(0)), 'An article.mp3');
	assert.equal(suggestAudioExportFilename(selectionSession, new Date(0)), 'An article-selection.mp3');
	assert.match(suggestAudioExportFilename(manualSession, new Date(0)), /^readit-pasted-text-.*\.mp3$/u);
	assert.equal(sanitizeMp3Filename('  bad:/name.  '), 'bad-name.mp3');
	assert.equal(sanitizeMp3Filename('Already.MP3'), 'Already.mp3');
	assert.equal(sanitizeMp3Filename(' . '), 'readit-export.mp3');
});

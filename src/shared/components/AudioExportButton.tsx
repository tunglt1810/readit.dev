import { useEffect, useState } from 'react';

import { LONG_AUDIO_EXPORT_SECONDS, suggestAudioExportFilename } from '../audio_export.ts';
import {
	cancelAudioExport,
	discardAudioExport,
	prepareAudioExport,
	requestAudioExportState,
	startAudioExport,
	subscribeAudioExportState,
} from '../audio_export_client.ts';
import { deleteAudioExportHandle, putAudioExportHandle } from '../audio_export_handle_store.ts';
import { t } from '../i18n.ts';
import type { AudioExportJobSnapshot, PlaybackSessionSnapshot } from '../types.ts';
import { PlaybackIcon } from './PlaybackIcon.tsx';

type ExportState = AudioExportJobSnapshot['state'] | 'ready';

function errorMessage(error: unknown): string {
	switch (error) {
		case 'permission-denied':
			return t('exportPermissionDenied');
		case 'write-failed':
			return t('exportWriteFailed');
		case 'encoding-failed':
			return t('exportEncodingFailed');
		case 'snapshot-unavailable':
			return t('exportSnapshotUnavailable');
		case 'interrupted':
			return t('exportInterrupted');
		default:
			return t('exportStartFailed');
	}
}

function labelFor(state: ExportState): string {
	switch (state) {
		case 'preparing':
			return t('exportPreparing');
		case 'exporting':
			return t('exportingMp3');
		case 'waiting-for-playback':
			return t('waitingForPlayback');
		case 'cancelling':
			return t('cancellingExport');
		case 'completed':
			return t('exportCompleted');
		case 'failed':
			return t('exportFailed');
		case 'interrupted':
			return t('exportInterrupted');
		default:
			return t('exportMp3');
	}
}

function pickerOptions(suggestedName: string) {
	return {
		id: 'readit-mp3-export',
		startIn: 'music',
		suggestedName,
		types: [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }],
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function canUseDownloadFallback(): boolean {
	return typeof chrome.downloads?.download === 'function';
}

function formatEstimate(seconds: number, bytes: number): string {
	return `${t('exportEstimatedDuration')}: ${Math.ceil(seconds / 60)} min · ${t('exportEstimatedSize')}: ${Math.round(bytes / 1_000_000)} MB`;
}

export function AudioExportButton({ session }: { session: PlaybackSessionSnapshot | null }) {
	const [job, setJob] = useState<AudioExportJobSnapshot | null>(null);
	const [starting, setStarting] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [showLongWarning, setShowLongWarning] = useState(false);
	const [showCancelConfirmation, setShowCancelConfirmation] = useState(false);
	const [dismissedCompletedJobId, setDismissedCompletedJobId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		let receivedLiveUpdate = false;
		const unsubscribe = subscribeAudioExportState(chrome.runtime, (nextJob) => {
			receivedLiveUpdate = true;
			if (!cancelled) {
				setJob(nextJob);
			}
		});
		void requestAudioExportState().then(
			(response) => {
				if (!cancelled && !receivedLiveUpdate) {
					setJob(response.job);
				}
			},
			() => {
				if (!cancelled && !receivedLiveUpdate) {
					setJob(null);
				}
			},
		);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		if (job?.state !== 'completed') {
			return;
		}
		const timeout = setTimeout(() => setDismissedCompletedJobId(job.jobId), 3_000);
		return () => clearTimeout(timeout);
	}, [job]);

	const hasExportableSession = session?.audioExportEstimate !== undefined;
	const jobState = job?.state === 'completed' && dismissedCompletedJobId === job.jobId ? 'ready' : (job?.state ?? 'ready');
	const activeJob =
		job &&
		(job.state === 'preparing' || job.state === 'exporting' || job.state === 'waiting-for-playback' || job.state === 'cancelling');
	const canRetry = jobState === 'failed' || jobState === 'interrupted';
	const disabled = starting || jobState === 'cancelling' || (!activeJob && !hasExportableSession && !canRetry);
	const label =
		jobState === 'exporting'
			? `${t('exportingMp3')} — ${Math.round(job?.progressPercentage ?? 0)}%`
			: jobState === 'ready'
				? t('exportMp3')
				: labelFor(jobState);
	const accessibleLabel = activeJob ? t('cancelExportMp3') : label;
	const statusText = localError ?? (jobState === 'failed' ? errorMessage(job?.errorCode) : labelFor(jobState));

	const startExport = async () => {
		if (!session || !session.audioExportEstimate || starting) {
			return;
		}
		setStarting(true);
		setLocalError(null);
		const jobId = crypto.randomUUID();
		const suggestedName = suggestAudioExportFilename(session, new Date());
		const canUsePicker = typeof window.showSaveFilePicker === 'function';
		if (!canUsePicker && !canUseDownloadFallback()) {
			setLocalError(t('exportStartFailed'));
			setStarting(false);
			return;
		}
		const preparePromise = prepareAudioExport({
			jobId,
			playbackSessionId: session.sessionId,
			title: session.contentScope === 'manual' ? t('pastedText') : session.source.title,
			outputFilename: suggestedName,
		});
		const pickerPromise = canUsePicker
			? window.showSaveFilePicker(pickerOptions(suggestedName))
			: Promise.resolve<FileSystemFileHandle | null>(null);
		try {
			const [preparedResult, pickerResult] = await Promise.allSettled([preparePromise, pickerPromise]);
			if (preparedResult.status === 'rejected') {
				throw preparedResult.reason;
			}
			if (pickerResult.status === 'rejected') {
				throw pickerResult.reason;
			}
			const prepared = preparedResult.value;
			const handle = pickerResult.value;
			if (!prepared.success) {
				throw prepared.error;
			}
			if (handle) {
				await putAudioExportHandle(jobId, handle);
			}
			const started = await startAudioExport(jobId);
			if (!started.success) {
				throw started.error;
			}
		} catch (error) {
			await deleteAudioExportHandle(jobId).catch(() => undefined);
			await discardAudioExport(jobId).catch(() => undefined);
			if (!isAbortError(error)) {
				setLocalError(errorMessage(error));
			}
		} finally {
			setStarting(false);
		}
	};

	const handleActivate = () => {
		if (activeJob) {
			setShowCancelConfirmation(true);
			return;
		}
		if (session?.audioExportEstimate && session.audioExportEstimate.durationSeconds >= LONG_AUDIO_EXPORT_SECONDS) {
			setShowLongWarning(true);
			return;
		}
		void startExport();
	};

	const confirmCancel = () => {
		if (job) {
			void cancelAudioExport(job.jobId);
		}
		setShowCancelConfirmation(false);
	};

	const icon = jobState === 'completed' ? 'check' : jobState === 'failed' || jobState === 'interrupted' ? 'warning' : 'download';
	const percent = Math.min(100, Math.max(0, Math.round(job?.progressPercentage ?? 0)));
	const strokeDashoffset = 56.548 * (1 - percent / 100);

	return (
		<div className="audio-export-control">
			<button
				className={`btn btn-secondary btn-icon-only audio-export-button ${starting ? 'is-starting' : ''}`}
				type="button"
				disabled={disabled}
				onClick={handleActivate}
				aria-label={accessibleLabel}
				title={label}
				data-tooltip={label}
				data-state={starting ? 'preparing' : jobState}
			>
				{jobState === 'preparing' || jobState === 'cancelling' || starting ? (
					<svg className="audio-export-progress-spinner" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeDasharray="42" strokeDashoffset="14" strokeLinecap="round" />
					</svg>
				) : jobState === 'exporting' || jobState === 'waiting-for-playback' ? (
					<svg className="audio-export-progress-ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						<circle cx="12" cy="12" r="9" stroke="rgba(255, 255, 255, 0.2)" strokeWidth="2.5" fill="none" />
						<circle
							cx="12"
							cy="12"
							r="9"
							stroke="currentColor"
							strokeWidth="2.5"
							fill="none"
							strokeDasharray="56.548"
							strokeDashoffset={strokeDashoffset}
							strokeLinecap="round"
							transform="rotate(-90 12 12)"
						/>
					</svg>
				) : (
					<PlaybackIcon name={icon} />
				)}
			</button>
			<div className="audio-export-status" role="status" aria-live="polite">
				{statusText}
			</div>
			{showLongWarning && (
				<div className="audio-export-dialog" role="alertdialog" aria-modal="true" aria-label={t('exportLongTitle')}>
					<p>{t('exportLongBody')}</p>
					<p>
						{session?.audioExportEstimate &&
							formatEstimate(session.audioExportEstimate.durationSeconds, session.audioExportEstimate.estimatedBytes)}
					</p>
					<div className="audio-export-dialog-actions">
						<button className="btn btn-secondary" type="button" onClick={() => setShowLongWarning(false)}>
							{t('cancel')}
						</button>
						<button
							className="btn btn-primary"
							type="button"
							onClick={() => {
								setShowLongWarning(false);
								void startExport();
							}}
						>
							{t('continue')}
						</button>
					</div>
				</div>
			)}
			{showCancelConfirmation && (
				<div className="audio-export-dialog" role="alertdialog" aria-modal="true" aria-label={t('cancelExportTitle')}>
					<p>{t('cancelExportBody')}</p>
					<div className="audio-export-dialog-actions">
						<button className="btn btn-secondary" type="button" onClick={() => setShowCancelConfirmation(false)}>
							{t('keepExport')}
						</button>
						<button className="btn btn-primary" type="button" onClick={confirmCancel}>
							{t('cancelExportMp3')}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

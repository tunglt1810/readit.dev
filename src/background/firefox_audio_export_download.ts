export type AudioExportDownloadsApi = {
	download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>;
	onChanged: {
		addListener(listener: (delta: { id: number; state?: { current?: string } }) => void): void;
		removeListener(listener: (delta: { id: number; state?: { current?: string } }) => void): void;
	};
};

type ObjectUrlApi = {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
};

export function createAudioExportDownloader(
	api: AudioExportDownloadsApi,
	objectUrls: ObjectUrlApi = URL,
): (blob: Blob, filename: string) => Promise<void> {
	return async (blob, filename) => {
		const url = objectUrls.createObjectURL(blob);
		try {
			const downloadId = await api.download({ url, filename, saveAs: true });
			const onChanged = (delta: { id: number; state?: { current?: string } }) => {
				if (delta.id !== downloadId || !['complete', 'interrupted'].includes(delta.state?.current ?? '')) {
					return;
				}
				api.onChanged.removeListener(onChanged);
				objectUrls.revokeObjectURL(url);
			};
			api.onChanged.addListener(onChanged);
		} catch (error) {
			objectUrls.revokeObjectURL(url);
			throw error;
		}
	};
}

// Compile-time constants injected by rsbuild source.define
declare const __BUILD_VERSION__: string;

interface SaveFilePickerOptions {}

interface Window {
	showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}

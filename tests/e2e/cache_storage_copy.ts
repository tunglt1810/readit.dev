import fs from 'node:fs';

export function copyDirectoryTreeSync(source: string, destination: string): void {
	fs.cpSync(source, destination, { recursive: true });
}

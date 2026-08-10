import { killOrphanChromeProcesses } from './global_setup';

export default async function globalTeardown(): Promise<void> {
	killOrphanChromeProcesses();
}

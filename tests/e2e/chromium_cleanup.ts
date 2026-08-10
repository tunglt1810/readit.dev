import { test } from '@playwright/test';
import { killOrphanChromeProcesses } from './global_setup';

test('cleanup orphan chrome processes between projects', async () => {
	killOrphanChromeProcesses();
	// Brief pause to let OS reclaim resources.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
});

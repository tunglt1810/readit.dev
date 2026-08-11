import React from 'react';
import { createRoot } from 'react-dom/client';

import { SettingsApp } from './SettingsApp';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import '../shared/theme.css';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import './settings.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Failed to find the root element');
}

const root = createRoot(container);
root.render(
	<React.StrictMode>
		<SettingsApp />
	</React.StrictMode>,
);

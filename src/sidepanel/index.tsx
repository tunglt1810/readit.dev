import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import '../shared/theme.css';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import './sidepanel.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Failed to find the Side Panel root element');
}

createRoot(container).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

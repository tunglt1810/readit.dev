import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import './popup.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Failed to find the root element');
}

const root = createRoot(container);
root.render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

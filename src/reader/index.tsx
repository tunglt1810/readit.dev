import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import '../shared/theme.css';
// @ts-expect-error Rsbuild bundles the stylesheet from this entry.
import './reader.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Failed to find the Document Reader root element');
}

createRoot(container).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

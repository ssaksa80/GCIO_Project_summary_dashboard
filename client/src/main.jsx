import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './themes.css';
import './responsive.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('GCIO dashboard: #root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);

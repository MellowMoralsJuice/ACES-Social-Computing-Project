import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { trackVisibleHeight } from './lib/device';
import './styles.css';

// The admin panel and results view live only on the hidden /admin route and are
// loaded on demand, so participants never download them.
const Admin = lazy(() => import('./admin/Admin'));
const Results = lazy(() => import('./admin/Results'));

const path = window.location.pathname.replace(/\/+$/, '');
const isAdmin = path === '/admin' || path.startsWith('/admin/');
document.documentElement.classList.toggle('is-admin', isAdmin);

// Stand-in for air taps: no long-press menu, no pinch or double-tap zoom on the participant view.
if (!isAdmin) {
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  document.addEventListener('dblclick', (event) => event.preventDefault());
  // Keep the whole layout above the on-screen keyboard (iPhone).
  trackVisibleHeight();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p className="loading">Loading…</p>}>
      {path === '/admin/results' ? <Results /> : isAdmin ? <Admin /> : <App />}
    </Suspense>
  </StrictMode>,
);

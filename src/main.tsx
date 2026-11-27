import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

(window as unknown as { __RETROPLAY_VITE_MOUNTED?: boolean }).__RETROPLAY_VITE_MOUNTED = true;
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {
      // Ignora erro de registro se bloqueado pelo ambiente
    });
  });
}

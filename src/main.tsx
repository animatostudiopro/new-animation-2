import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Auto-updater: ensures latest deployments on GitHub/Cloudflare and mobile APK are loaded immediately
(function initGameAutoUpdater() {
  if (typeof window === 'undefined') return;

  const STORAGE_KEY = 'animato_game_deployed_at';
  let isChecking = false;

  async function checkDeploymentUpdate() {
    if (isChecking) return;
    isChecking = true;
    try {
      // Use relative path to meta file to handle nested native folder structures
      const metaUrl = new URL('./deployment-meta.json', window.location.href).href;
      const res = await fetch(metaUrl + '?_t=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
      });
      if (res.ok) {
        const meta = await res.json();
        const serverDeployedAt = meta?.deployedAt;
        if (serverDeployedAt) {
          const localDeployedAt = localStorage.getItem(STORAGE_KEY);
          if (!localDeployedAt) {
            localStorage.setItem(STORAGE_KEY, serverDeployedAt);
          } else if (localDeployedAt !== serverDeployedAt) {
            console.log('[GameRunner] Newer deployment detected (' + serverDeployedAt + '). Performing hard refresh...');
            localStorage.setItem(STORAGE_KEY, serverDeployedAt);
            
            // 1. Unregister Service Workers
            if ('serviceWorker' in navigator) {
              try {
                const regs = await navigator.serviceWorker.getRegistrations();
                for (const reg of regs) await reg.unregister();
              } catch (_) {}
            }

            // 2. Clear Caches
            if ('caches' in window) {
              try {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
              } catch (_) {}
            }
            
            // 3. Force versioned reload
            const url = new URL(window.location.href);
            url.searchParams.set('upd', serverDeployedAt);
            window.location.href = url.toString();
          }
        }
      }
    } catch (_) {}
    finally {
      isChecking = false;
    }
  }

  // Register service worker if available
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        reg.update().catch(() => {});
      }).catch(() => {});
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[GameRunner] Service worker updated. Refreshing...');
    });
  }

  // Check on launch and on resume/focus
  setTimeout(checkDeploymentUpdate, 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDeploymentUpdate();
  });
  window.addEventListener('focus', checkDeploymentUpdate);
  setInterval(checkDeploymentUpdate, 60000);
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

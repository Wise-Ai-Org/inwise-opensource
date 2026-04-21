import React from 'react';
import { createRoot } from 'react-dom/client';
import Badge from './Badge';

window.addEventListener('unhandledrejection', (event) => {
  const reason: any = event.reason;
  try {
    (window as any).electronAPI?.reportUnhandledRejection?.({
      name: reason?.name || 'UnhandledRejection',
      message: reason?.message || (typeof reason === 'string' ? reason : String(reason)),
      stack: reason?.stack,
      source: 'badge-window',
    });
  } catch {
    // never let error reporting itself throw
  }
});

const root = createRoot(document.getElementById('root')!);
root.render(<Badge />);

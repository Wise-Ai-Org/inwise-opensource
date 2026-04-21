import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import App from './App';
import theme from './theme/theme';
import './styles.css';

window.addEventListener('unhandledrejection', (event) => {
  const reason: any = event.reason;
  try {
    (window as any).inwiseAPI?.reportUnhandledRejection?.({
      name: reason?.name || 'UnhandledRejection',
      message: reason?.message || (typeof reason === 'string' ? reason : String(reason)),
      stack: reason?.stack,
      source: 'main-window',
    });
  } catch {
    // never let error reporting itself throw
  }
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <ChakraProvider theme={theme}>
    <ColorModeScript initialColorMode="light" />
    <App />
  </ChakraProvider>
);

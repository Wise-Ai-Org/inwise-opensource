import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import App from './App';
import ReviewWindow from './ReviewWindow';
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

// A ?review=<meetingId> query means this window is the standalone transcript
// review window (opened by main), not the tray popup.
const params = new URLSearchParams(window.location.search);
const reviewMeetingId = params.get('review');

const root = createRoot(document.getElementById('root')!);
root.render(
  <ChakraProvider theme={theme}>
    <ColorModeScript initialColorMode="light" />
    {reviewMeetingId
      ? <ReviewWindow meetingId={reviewMeetingId} initialTab={params.get('tab') || undefined} />
      : <App />}
  </ChakraProvider>
);

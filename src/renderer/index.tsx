import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import App from './App';
import theme from './theme/theme';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <ChakraProvider theme={theme}>
    <ColorModeScript initialColorMode="light" />
    <App />
  </ChakraProvider>
);

import { extendTheme } from '@chakra-ui/react';

export const theme = extendTheme({
  config: {
    initialColorMode: 'light',
    useSystemColorMode: false,
  },
  fonts: {
    body: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
    heading: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  colors: {
    brand: {
      50: '#f0fdfa',
      100: '#ccfbf1',
      200: '#99f6e4',
      300: '#5eead4',
      400: '#14b8a6',
      500: '#0d9488',
      600: '#0f766e',
      700: '#115e59',
      800: '#134e4a',
      900: '#042f2e',
    },
    navy: {
      50: '#f8fafc',
      100: '#f1f5f9',
      200: '#e2e8f0',
      300: '#cbd5e1',
      400: '#94a3b8',
      500: '#64748b',
      600: '#475569',
      700: '#334155',
      800: '#1e293b',
      900: '#0f172a',
    },
    secondaryGray: {
      100: '#e2e8f0',
      200: '#e2e8f0',
      300: '#f8fafc',
      400: '#cbd5e1',
      500: '#94a3b8',
      600: '#94a3b8',
      700: '#64748b',
      800: '#64748b',
      900: '#0f172a',
    },
  },
  styles: {
    global: {
      body: {
        letterSpacing: '-0.01em',
      },
    },
  },
  components: {
    Button: {
      variants: {
        solid: (props: any) => ({
          ...(props.colorScheme === 'brand' && {
            bg: 'brand.500',
            color: 'white',
            _hover: { bg: 'brand.600' },
            _active: { bg: 'brand.700' },
          }),
        }),
        outline: (props: any) => ({
          ...(props.colorScheme === 'brand' && {
            borderColor: 'brand.500',
            color: 'brand.500',
            _hover: { bg: 'brand.50' },
          }),
        }),
      },
    },
  },
});

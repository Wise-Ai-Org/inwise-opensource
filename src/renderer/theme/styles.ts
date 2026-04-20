import { mode } from '@chakra-ui/theme-tools';
export const globalStyles = {
  fonts: {
    body: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
    heading: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif"
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
      900: '#042f2e'
    },
    brandScheme: {
      50: '#f0fdfa',
      100: '#ccfbf1',
      200: '#99f6e4',
      300: '#5eead4',
      400: '#14b8a6',
      500: '#0d9488',
      600: '#0f766e',
      700: '#115e59',
      800: '#134e4a',
      900: '#042f2e'
    },
    brandTabs: {
      50: '#f0fdfa',
      100: '#ccfbf1',
      200: '#99f6e4',
      300: '#5eead4',
      400: '#14b8a6',
      500: '#0d9488',
      600: '#0f766e',
      700: '#115e59',
      800: '#134e4a',
      900: '#042f2e'
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
      900: '#0f172a'
    },
    red: {
      100: '#fef2f2',
      500: '#ef4444',
      600: '#dc2626'
    },
    blue: {
      50: '#eff6ff',
      500: '#3b82f6'
    },
    orange: {
      100: '#fffbeb',
      500: '#f59e0b'
    },
    green: {
      100: '#ecfdf5',
      500: '#10b981'
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
      900: '#0f172a'
    },
    gray: {
      100: '#f8fafc'
    }
  },
  styles: {
    global: (props: any) => ({
      body: {
        overflowX: 'hidden',
        bg: mode('navy.50', 'navy.900')(props),
        fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
        letterSpacing: '-0.01em'
      },
      input: {
        color: 'gray.700'
      },
      html: {
        fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif"
      }
    })
  }
};

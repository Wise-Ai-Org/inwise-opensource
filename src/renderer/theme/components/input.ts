import { mode } from '@chakra-ui/theme-tools';
export const inputStyles = {
  components: {
    Input: {
      baseStyle: {
        field: {
          fontWeight: 400,
          borderRadius: '6px'
        }
      },

      variants: {
        main: (props: any) => ({
          field: {
            bg: mode('transparent', 'navy.800')(props),
            border: '1px solid',
            color: mode('secondaryGray.900', 'white')(props),
            borderColor: mode('secondaryGray.400', 'whiteAlpha.100')(props),
            borderRadius: '6px',
            fontSize: 'sm',
            p: '10px 12px',
            _placeholder: { color: 'secondaryGray.500' },
            _focus: {
              borderColor: 'brand.500',
              boxShadow: '0 0 0 3px rgba(13, 148, 136, 0.15)'
            }
          }
        }),
        auth: (props: any) => ({
          field: {
            fontWeight: '500',
            color: mode('navy.700', 'white')(props),
            bg: mode('transparent', 'transparent')(props),
            border: '1px solid',
            borderColor: mode('secondaryGray.400', 'rgba(135, 140, 189, 0.3)')(props),
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500', fontWeight: '400' },
            _focus: {
              borderColor: 'brand.500',
              boxShadow: '0 0 0 3px rgba(13, 148, 136, 0.15)'
            }
          }
        }),
        authSecondary: () => ({
          field: {
            bg: 'transparent',
            border: '1px solid',
            borderColor: 'secondaryGray.400',
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500' }
          }
        }),
        search: () => ({
          field: {
            border: 'none',
            py: '11px',
            borderRadius: 'inherit',
            _placeholder: { color: 'secondaryGray.500' }
          }
        })
      }
    },
    NumberInput: {
      baseStyle: {
        field: {
          fontWeight: 400
        }
      },

      variants: {
        main: () => ({
          field: {
            bg: 'transparent',
            border: '1px solid',
            borderColor: 'secondaryGray.400',
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500' }
          }
        }),
        search: () => ({
          field: {
            border: 'none',
            py: '11px',
            borderRadius: 'inherit',
            _placeholder: { color: 'secondaryGray.500' }
          }
        })
      }
    },
    Select: {
      baseStyle: {
        field: {
          fontWeight: 400
        }
      },

      variants: {
        main: (props: any) => ({
          field: {
            bg: mode('transparent', 'navy.800')(props),
            border: '1px solid',
            color: 'secondaryGray.700',
            borderColor: mode('secondaryGray.400', 'whiteAlpha.100')(props),
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500' }
          },
          icon: {
            color: 'secondaryGray.500'
          }
        }),
        mini: (props: any) => ({
          field: {
            bg: mode('transparent', 'navy.800')(props),
            border: '0px solid transparent',
            fontSize: '0px',
            p: '10px',
            _placeholder: { color: 'secondaryGray.500' }
          },
          icon: {
            color: 'secondaryGray.500'
          }
        }),
        subtle: () => ({
          box: {
            width: 'unset'
          },
          field: {
            bg: 'transparent',
            border: '0px solid',
            color: 'secondaryGray.700',
            borderColor: 'transparent',
            width: 'max-content',
            _placeholder: { color: 'secondaryGray.500' }
          },
          icon: {
            color: 'secondaryGray.500'
          }
        }),
        transparent: (props: any) => ({
          field: {
            bg: 'transparent',
            border: '0px solid',
            width: 'min-content',
            color: mode('secondaryGray.700', 'secondaryGray.500')(props),
            borderColor: 'transparent',
            padding: '0px',
            paddingLeft: '8px',
            paddingRight: '20px',
            fontWeight: '600',
            fontSize: '14px',
            _placeholder: { color: 'secondaryGray.500' }
          },
          icon: {
            transform: 'none !important',
            position: 'unset !important',
            width: 'unset',
            color: 'secondaryGray.500',
            right: '0px'
          }
        }),
        auth: () => ({
          field: {
            bg: 'transparent',
            border: '1px solid',
            borderColor: 'secondaryGray.400',
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500' }
          }
        }),
        authSecondary: () => ({
          field: {
            bg: 'transparent',
            border: '1px solid',
            borderColor: 'secondaryGray.400',
            borderRadius: '6px',
            _placeholder: { color: 'secondaryGray.500' }
          }
        }),
        search: () => ({
          field: {
            border: 'none',
            py: '11px',
            borderRadius: 'inherit',
            _placeholder: { color: 'secondaryGray.500' }
          }
        })
      }
    }
  }
};

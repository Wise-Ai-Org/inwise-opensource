import { mode } from '@chakra-ui/theme-tools';
export const textareaStyles = {
  components: {
    Textarea: {
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
            border: '1px solid !important',
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

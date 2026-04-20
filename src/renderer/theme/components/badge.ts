import { mode } from '@chakra-ui/theme-tools';
export const badgeStyles = {
  components: {
    Badge: {
      baseStyle: {
        borderRadius: '9999px',
        lineHeight: '1.5',
        padding: '2px 8px',
        fontSize: 'xs',
        fontWeight: '500'
      },
      variants: {
        outline: () => ({
          borderRadius: '9999px'
        }),
        brand: (props: any) => ({
          bg: mode('brand.50', 'brand.400')(props),
          color: mode('brand.700', 'white')(props),
          _focus: {
            bg: mode('brand.50', 'brand.400')(props)
          },
          _active: {
            bg: mode('brand.100', 'brand.400')(props)
          },
          _hover: {
            bg: mode('brand.100', 'brand.400')(props)
          }
        })
      }
    }
  }
};

import { mode } from '@chakra-ui/theme-tools';
const Card = {
  baseStyle: (props: any) => ({
    p: '20px',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    position: 'relative',
    borderRadius: '8px',
    minWidth: '0px',
    wordWrap: 'break-word',
    bg: mode('white', 'navy.800')(props),
    border: '1px solid',
    borderColor: mode('navy.200', 'transparent')(props),
    boxShadow: mode('0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)', 'unset')(props),
    backgroundClip: 'border-box'
  })
};

export const CardComponent = {
  components: {
    Card
  }
};

import React from 'react';
import { useStyleConfig, chakra, forwardRef } from '@chakra-ui/react';
import { CustomCardProps } from '../../theme/theme';

const CustomCard = forwardRef<CustomCardProps, 'div'>((props, ref) => {
  const { size, variant, ...rest } = props;
  const styles = useStyleConfig('Card', { size, variant });

  const customStyles = {
    ...styles,
    boxShadow: '0 4px 8px 0 rgba(0,0,0,0.1)'
  };

  return <chakra.div ref={ref} __css={customStyles} {...rest} />;
});

export default CustomCard;

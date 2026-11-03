import React from 'react';
// @ts-ignore webpack image asset
import owl from '../assets/inwise-owl.jpg';

/** Approved owl artwork with a separate, readable lowercase wordmark. */
export default function InwiseBrand({ size = 32, fontSize = 20 }: { size?: number; fontSize?: number }) {
  return (
    <span role="img" aria-label="inwise" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>
      <img src={owl} alt="" style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }} />
      <span aria-hidden="true" style={{ color: '#013d54', fontFamily: 'var(--font-story, "DM Sans", sans-serif)', fontSize, fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1 }}>inwise</span>
    </span>
  );
}

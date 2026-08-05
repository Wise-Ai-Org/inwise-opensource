import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import '../ai-button.css';

type AiButtonTone = 'light' | 'dark' | 'solid';
type AiButtonSize = 'sm' | 'md';

interface AiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  busyLabel?: ReactNode;
  tone?: AiButtonTone;
  size?: AiButtonSize;
  trailing?: ReactNode;
}

export const AiButton = forwardRef<HTMLButtonElement, AiButtonProps>(function AiButton(
  {
    busy = false,
    busyLabel = 'Wiser is thinking…',
    tone = 'light',
    size = 'md',
    trailing,
    className,
    children,
    disabled,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      {...props}
      disabled={disabled || busy}
      aria-busy={busy}
      data-busy={busy ? 'true' : 'false'}
      data-size={size}
      data-tone={tone}
      className={['inwise-ai-button', className].filter(Boolean).join(' ')}
    >
      <span className="inwise-ai-button__surface">
        <span className="inwise-ai-button__spark" aria-hidden="true">
          <i>✦</i>
          <i>✦</i>
          <i>✦</i>
        </span>
        <span className="inwise-ai-button__label">{busy ? busyLabel : children}</span>
        {!busy && trailing ? <span className="inwise-ai-button__trailing">{trailing}</span> : null}
        <span className="inwise-ai-button__signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
    </button>
  );
});

import React from 'react';
import { WelcomeBackModal } from '@inwise/desktop-shared';
import { ossWelcomeBackAdapter } from './adapters/ossWelcomeBackAdapter';

interface Props {
  onNavigate: (view: any) => void;
  onDismiss: () => void;
}

export default function WelcomeBack({ onDismiss }: Props) {
  return <WelcomeBackModal adapter={ossWelcomeBackAdapter} onDismissed={onDismiss} />;
}

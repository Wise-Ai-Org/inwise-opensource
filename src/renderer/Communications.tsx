import React from 'react';
import { CommunicationsView } from '@inwise/desktop-shared';
import { ossCommunicationsAdapter } from './adapters/ossCommunicationsAdapter';

interface Props {
  pendingOpen?: { meetingId: string; focusTab?: string } | null;
  onPendingOpenConsumed?: () => void;
}

export default function Communications(_props: Props) {
  return <CommunicationsView adapter={ossCommunicationsAdapter} />;
}

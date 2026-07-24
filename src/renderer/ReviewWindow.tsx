import React from 'react';
import TranscriptReviewModal from './views/communications/TranscriptReviewModal';

/**
 * Standalone transcript-review window. The tray popup is too narrow for the
 * five-tab review flow, so main opens app://bundle/index.html?review=<id> in a
 * normal resizable window and this component fills it with the existing modal.
 */
export default function ReviewWindow({ meetingId, initialTab }: { meetingId: string; initialTab?: string }) {
  return (
    <TranscriptReviewModal
      isOpen
      meetingId={meetingId}
      initialTab={initialTab as any}
      onClose={() => window.close()}
      onApproved={() => window.close()}
    />
  );
}

import React, { useState } from 'react';
import TranscriptReviewModal from './views/communications/TranscriptReviewModal';
import JiraMappingModal from './views/communications/JiraMappingModal';

/**
 * Standalone transcript-review window. The tray popup is too narrow for the
 * five-tab review flow, so main opens app://bundle/index.html?review=<id> in a
 * normal resizable window and this component fills it with the existing modal.
 *
 * After approval, the legacy wide-window flow auto-opened Jira mapping when
 * Jira is connected and the meeting has action items — preserved here.
 */
export default function ReviewWindow({ meetingId, initialTab }: { meetingId: string; initialTab?: string }) {
  const [mapping, setMapping] = useState<{ actionItems: Array<{ text: string; owner?: string }>; title: string } | null>(null);

  const handleApproved = async () => {
    try {
      const api = (window as any).inwiseAPI;
      const [status, meeting] = await Promise.all([api.jiraStatus?.(), api.getMeeting?.(meetingId)]);
      const connected = !!(status?.connected || status?.isConnected);
      const items = (meeting?.insights?.actionItems || []).map((ai: any) => ({ text: ai.text, owner: ai.owner || ai.assignee }));
      if (connected && items.length > 0) {
        setMapping({ actionItems: items, title: meeting?.title || '' });
        return;
      }
    } catch { /* fall through to close */ }
    window.close();
  };

  if (mapping) {
    return (
      <JiraMappingModal
        isOpen
        onClose={() => window.close()}
        actionItems={mapping.actionItems}
        meetingTitle={mapping.title}
        meetingId={meetingId}
        onComplete={() => { /* window closes via onClose/Done */ }}
      />
    );
  }

  return (
    <TranscriptReviewModal
      isOpen
      meetingId={meetingId}
      initialTab={initialTab as any}
      onClose={() => window.close()}
      onApproved={handleApproved}
    />
  );
}

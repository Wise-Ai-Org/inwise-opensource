import React from 'react';
import { SettingsShell } from '@inwise/desktop-shared';
import type { AudioTabProps } from '@inwise/desktop-shared';
import { ossCalendarAdapter } from './adapters/ossCalendarAdapter';
import { ossSettingsAdapter } from './adapters/ossSettingsAdapter';

const audioTabProps: AudioTabProps = {
  onSelectionChange: ({ micId, speakerId }) => {
    const updates: Record<string, any> = {};
    if (micId !== undefined) updates.micDeviceId = micId;
    if (speakerId !== undefined) updates.speakerDeviceId = speakerId;
    if (Object.keys(updates).length > 0) {
      (window as any).inwiseAPI.setConfig(updates);
    }
  },
};

export default function Settings() {
  return (
    <>
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Configure your AI provider, transcription model, and calendar</div>
      </div>
      <div className="page-body" style={{ display: 'flex', height: 'calc(100vh - 72px)', overflow: 'hidden' }}>
        <SettingsShell
          adapter={ossSettingsAdapter}
          calendarAdapter={ossCalendarAdapter}
          audioTabProps={audioTabProps}
        />
      </div>
    </>
  );
}

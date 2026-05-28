import React from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingToast } from '@inwise/desktop-shared';
import { ossToastAdapter } from './adapters/ossToastAdapter';

const root = createRoot(document.getElementById('root')!);
root.render(<MeetingToast adapter={ossToastAdapter} />);

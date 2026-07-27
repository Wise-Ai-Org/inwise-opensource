import React from 'react';
import { createRoot } from 'react-dom/client';
import DailyPlan from './DailyPlan';

const root = createRoot(document.getElementById('root')!);
root.render(<DailyPlan />);

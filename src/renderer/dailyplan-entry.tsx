import React from 'react';
import { createRoot } from 'react-dom/client';
import DailyPlan from './DailyPlan';
import './owl.css';

const root = createRoot(document.getElementById('root')!);
root.render(<DailyPlan />);

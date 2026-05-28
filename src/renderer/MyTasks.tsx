import React from 'react';
import { TasksView } from '@inwise/desktop-shared';
import { ossTasksAdapter } from './adapters/ossTasksAdapter';

interface Props {
  onNavigate?: (view: string) => void;
}

export default function MyTasks(_props: Props) {
  return <TasksView adapter={ossTasksAdapter} />;
}

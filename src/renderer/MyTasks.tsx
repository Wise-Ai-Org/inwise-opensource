import React, { useState, useEffect } from 'react';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Task {
  id: string;
  text: string;
  owner?: string;
  due_date?: string;
  status: 'todo' | 'inprogress' | 'done';
  priority: 'high' | 'medium' | 'low';
  meeting_title?: string;
  source: 'manual' | 'ai';
}

const COLUMNS: { id: Task['status']; label: string; color: string }[] = [
  { id: 'todo',       label: 'To Do',       color: 'var(--slate-300)' },
  { id: 'inprogress', label: 'In Progress',  color: 'var(--amber)' },
  { id: 'done',       label: 'Done',         color: 'var(--green)' },
];

const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--red)', medium: 'var(--amber)', low: 'var(--teal)',
};

function TaskCard({ task, onStatusChange, onDelete }: {
  task: Task;
  onStatusChange: (id: string, status: Task['status']) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  return (
    <div ref={setNodeRef} style={style} className="task-card" {...attributes} {...listeners}>
      <div className="task-card-header">
        <span
          className="task-priority-dot"
          style={{ background: PRIORITY_COLORS[task.priority] }}
          title={task.priority}
        />
        <span className="task-text">{task.text}</span>
        <button
          className="task-delete"
          onClick={e => { e.stopPropagation(); onDelete(task.id); }}
          title="Delete"
        >×</button>
      </div>
      {(task.owner || task.due_date || task.meeting_title) && (
        <div className="task-meta">
          {task.owner && <span>{task.owner}</span>}
          {task.due_date && <span>Due {task.due_date}</span>}
          {task.meeting_title && (
            <span className="task-source">
              {task.source === 'ai' ? '✦ ' : ''}{task.meeting_title}
            </span>
          )}
        </div>
      )}
      <div className="task-move-btns">
        {COLUMNS.filter(c => c.id !== task.status).map(c => (
          <button
            key={c.id}
            className="task-move-btn"
            onClick={e => { e.stopPropagation(); onStatusChange(task.id, c.id); }}
          >
            → {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddTaskForm({ onAdd }: { onAdd: (text: string, priority: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('medium');

  const submit = () => {
    if (!text.trim()) return;
    onAdd(text.trim(), priority);
    setText('');
    setPriority('medium');
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="add-task-btn" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  }

  return (
    <div className="add-task-form">
      <input
        className="form-input"
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="What needs to be done?"
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <select className="form-select" style={{ flex: 1 }} value={priority} onChange={e => setPriority(e.target.value)}>
          <option value="high">High priority</option>
          <option value="medium">Medium priority</option>
          <option value="low">Low priority</option>
        </select>
        <button className="btn btn-primary btn-sm" onClick={submit}>Add</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export default function MyTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const load = async () => {
    const data = await (window as any).inwiseAPI.getTasks();
    setTasks(data || []);
  };

  useEffect(() => { load(); }, []);

  const addTask = async (text: string, priority: string) => {
    const task = await (window as any).inwiseAPI.createTask({ text, priority });
    setTasks(prev => [task, ...prev]);
  };

  const changeStatus = async (id: string, status: Task['status']) => {
    const updated = await (window as any).inwiseAPI.updateTask(id, { status });
    setTasks(prev => prev.map(t => t.id === id ? updated : t));
  };

  const remove = async (id: string) => {
    await (window as any).inwiseAPI.deleteTask(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleDragStart = (e: DragStartEvent) => setActiveId(e.active.id as string);

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    // Check if dropped on a column
    const col = COLUMNS.find(c => c.id === over.id);
    if (col) {
      const task = tasks.find(t => t.id === active.id);
      if (task && task.status !== col.id) {
        await changeStatus(active.id as string, col.id);
      }
    }
  };

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;
  const tasksByStatus = (status: Task['status']) => tasks.filter(t => t.status === status);

  return (
    <>
      <div className="page-header">
        <div className="page-title">My Tasks</div>
        <div className="page-subtitle">
          {tasks.filter(t => t.status !== 'done').length} open · {tasks.filter(t => t.status === 'done').length} done
        </div>
      </div>
      <div className="page-body" style={{ overflow: 'auto' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="kanban-board">
            {COLUMNS.map(col => (
              <div key={col.id} className="kanban-col">
                <div className="kanban-col-header">
                  <span className="kanban-col-dot" style={{ background: col.color }} />
                  <span className="kanban-col-label">{col.label}</span>
                  <span className="kanban-col-count">{tasksByStatus(col.id).length}</span>
                </div>

                <SortableContext
                  items={tasksByStatus(col.id).map(t => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="kanban-col-body" id={col.id}>
                    {col.id === 'todo' && <AddTaskForm onAdd={addTask} />}
                    {tasksByStatus(col.id).map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onStatusChange={changeStatus}
                        onDelete={remove}
                      />
                    ))}
                    {tasksByStatus(col.id).length === 0 && col.id !== 'todo' && (
                      <div className="kanban-empty">Drop tasks here</div>
                    )}
                  </div>
                </SortableContext>
              </div>
            ))}
          </div>

          <DragOverlay>
            {activeTask && (
              <div className="task-card" style={{ transform: 'rotate(2deg)', boxShadow: 'var(--shadow-md)' }}>
                <div className="task-card-header">
                  <span className="task-priority-dot" style={{ background: PRIORITY_COLORS[activeTask.priority] }} />
                  <span className="task-text">{activeTask.text}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </>
  );
}

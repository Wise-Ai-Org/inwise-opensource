import React, { useState } from 'react';

interface Props {
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  eventDates?: Set<string>; // 'YYYY-MM-DD' strings that have events
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function toKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export default function MiniCalendar({ selectedDate, onSelectDate, eventDates = new Set() }: Props) {
  const [view, setView] = useState(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const today = new Date();
  const todayKey = toKey(today);
  const selectedKey = toKey(selectedDate);

  const prevMonth = () => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const nextMonth = () => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));

  const firstDay = view.getDay();
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="mini-calendar">
      <div className="mini-cal-header">
        <button className="mini-cal-nav" onClick={prevMonth}>‹</button>
        <span className="mini-cal-title">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
        <button className="mini-cal-nav" onClick={nextMonth}>›</button>
      </div>
      <div className="mini-cal-grid">
        {DAYS.map(d => <div key={d} className="mini-cal-day-label">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const date = new Date(view.getFullYear(), view.getMonth(), day);
          const key = toKey(date);
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          const hasEvent = eventDates.has(key);
          return (
            <div
              key={key}
              className={`mini-cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
              onClick={() => onSelectDate(date)}
            >
              {day}
              {hasEvent && <span className="mini-cal-dot" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { Database } from 'node-sqlite3-wasm';

let db: Database;

export function getDb(): Database {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'data.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
  }
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      duration INTEGER DEFAULT 0,
      transcript TEXT,
      summary TEXT,
      calendar_event_id TEXT,
      source TEXT DEFAULT 'desktop_recording',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      owner TEXT,
      due_date TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      rationale TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blockers (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      severity TEXT DEFAULT 'medium',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      role TEXT,
      company TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meeting_people (
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
      PRIMARY KEY (meeting_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      owner TEXT,
      due_date TEXT,
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(sql: string, params: any[] = []): void {
  const stmt = getDb().prepare(sql);
  stmt.run(params);
  stmt.finalize();
}

function get(sql: string, params: any[] = []): any {
  const stmt = getDb().prepare(sql);
  const row = stmt.get(params);
  stmt.finalize();
  return row || null;
}

function all(sql: string, params: any[] = []): any[] {
  const stmt = getDb().prepare(sql);
  const rows = stmt.all(params);
  stmt.finalize();
  return rows;
}

// ── Meetings ──────────────────────────────────────────────────────────────────

export function createMeeting(data: {
  title: string;
  date: string;
  duration?: number;
  calendarEventId?: string;
  source?: string;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO meetings (id, title, date, duration, calendar_event_id, source, status)
     VALUES (?, ?, ?, ?, ?, ?, 'recording')`,
    [id, data.title, data.date, data.duration || 0, data.calendarEventId || null, data.source || 'desktop_recording']
  );
  return id;
}

export function updateMeetingTranscript(id: string, transcript: string, duration: number): void {
  run(`UPDATE meetings SET transcript = ?, duration = ?, status = 'transcribed' WHERE id = ?`,
    [transcript, duration, id]);
}

export function updateMeetingInsights(id: string, summary: string): void {
  run(`UPDATE meetings SET summary = ?, status = 'completed' WHERE id = ?`, [summary, id]);
}

export function getMeetings(): any[] {
  return all(`
    SELECT m.*,
      (SELECT COUNT(*) FROM action_items WHERE meeting_id = m.id) as action_item_count,
      (SELECT COUNT(*) FROM blockers WHERE meeting_id = m.id) as blocker_count,
      (SELECT COUNT(*) FROM decisions WHERE meeting_id = m.id) as decision_count
    FROM meetings m ORDER BY m.date DESC
  `);
}

export function getMeeting(id: string): any {
  const meeting = get('SELECT * FROM meetings WHERE id = ?', [id]);
  if (!meeting) return null;
  meeting.actionItems = all('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at', [id]);
  meeting.decisions   = all('SELECT * FROM decisions WHERE meeting_id = ? ORDER BY created_at', [id]);
  meeting.blockers    = all('SELECT * FROM blockers WHERE meeting_id = ? ORDER BY created_at', [id]);
  meeting.people      = all(`
    SELECT p.* FROM people p
    JOIN meeting_people mp ON p.id = mp.person_id
    WHERE mp.meeting_id = ?
  `, [id]);
  return meeting;
}

export function deleteMeeting(id: string): void {
  run('DELETE FROM meetings WHERE id = ?', [id]);
}

// ── Insights ──────────────────────────────────────────────────────────────────

export function saveInsights(meetingId: string, insights: {
  summary: string;
  actionItems: { text: string; owner?: string; dueDate?: string; priority?: string }[];
  decisions: { text: string; rationale?: string }[];
  blockers: { text: string; severity?: string }[];
  people: { name: string; email?: string; role?: string; company?: string }[];
}): void {
  updateMeetingInsights(meetingId, insights.summary);

  for (const item of insights.actionItems) {
    const taskId = uuidv4();
    run(`INSERT INTO action_items (id, meeting_id, text, owner, due_date, priority) VALUES (?,?,?,?,?,?)`,
      [taskId, meetingId, item.text, item.owner || null, item.dueDate || null, item.priority || 'medium']);
    // Also insert into tasks table so it appears in My Tasks
    run(`INSERT INTO tasks (id, text, owner, due_date, priority, meeting_id, source, status) VALUES (?,?,?,?,?,?,'ai','todo')`,
      [uuidv4(), item.text, item.owner || null, item.dueDate || null, item.priority || 'medium', meetingId]);
  }

  for (const d of insights.decisions) {
    run(`INSERT INTO decisions (id, meeting_id, text, rationale) VALUES (?,?,?,?)`,
      [uuidv4(), meetingId, d.text, d.rationale || null]);
  }

  for (const b of insights.blockers) {
    run(`INSERT INTO blockers (id, meeting_id, text, severity) VALUES (?,?,?,?)`,
      [uuidv4(), meetingId, b.text, b.severity || 'medium']);
  }

  for (const person of insights.people) {
    let personId: string;
    const existing = get('SELECT id FROM people WHERE name = ? OR (email IS NOT NULL AND email = ?)',
      [person.name, person.email || '']) as any;
    if (existing) {
      personId = existing.id;
    } else {
      personId = uuidv4();
      run(`INSERT OR IGNORE INTO people (id, name, email, role, company) VALUES (?,?,?,?,?)`,
        [personId, person.name, person.email || null, person.role || null, person.company || null]);
    }
    run(`INSERT OR IGNORE INTO meeting_people (meeting_id, person_id) VALUES (?,?)`,
      [meetingId, personId]);
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function getTasks(): any[] {
  return all(`
    SELECT t.*, m.title as meeting_title
    FROM tasks t
    LEFT JOIN meetings m ON t.meeting_id = m.id
    ORDER BY
      CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      t.created_at DESC
  `);
}

export function createTask(data: {
  text: string;
  owner?: string;
  dueDate?: string;
  priority?: string;
}): any {
  const id = uuidv4();
  run(`INSERT INTO tasks (id, text, owner, due_date, priority, source, status) VALUES (?,?,?,?,?,'manual','todo')`,
    [id, data.text, data.owner || null, data.dueDate || null, data.priority || 'medium']);
  return get('SELECT * FROM tasks WHERE id = ?', [id]);
}

export function updateTask(id: string, updates: {
  text?: string;
  status?: string;
  priority?: string;
  owner?: string;
  dueDate?: string;
}): any {
  const fields: string[] = [];
  const vals: any[] = [];
  if (updates.text !== undefined)     { fields.push('text = ?');     vals.push(updates.text); }
  if (updates.status !== undefined)   { fields.push('status = ?');   vals.push(updates.status); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); vals.push(updates.priority); }
  if (updates.owner !== undefined)    { fields.push('owner = ?');    vals.push(updates.owner); }
  if (updates.dueDate !== undefined)  { fields.push('due_date = ?'); vals.push(updates.dueDate); }
  if (fields.length === 0) return get('SELECT * FROM tasks WHERE id = ?', [id]);
  vals.push(id);
  run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, vals);
  return get('SELECT t.*, m.title as meeting_title FROM tasks t LEFT JOIN meetings m ON t.meeting_id = m.id WHERE t.id = ?', [id]);
}

export function deleteTask(id: string): void {
  run('DELETE FROM tasks WHERE id = ?', [id]);
}

// ── People ───────────────────────────────────────────────────────────────────

export function getPeople(): any[] {
  return all(`
    SELECT p.*,
      COUNT(DISTINCT mp.meeting_id) as meeting_count
    FROM people p
    LEFT JOIN meeting_people mp ON p.id = mp.person_id
    GROUP BY p.id ORDER BY p.name
  `);
}

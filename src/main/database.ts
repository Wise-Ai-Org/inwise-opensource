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
    run(`INSERT INTO action_items (id, meeting_id, text, owner, due_date, priority) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), meetingId, item.text, item.owner || null, item.dueDate || null, item.priority || 'medium']);
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

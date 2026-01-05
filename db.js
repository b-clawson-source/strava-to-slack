import sqlite3 from "sqlite3";
import path from "path";

const dbPath = path.resolve(process.cwd(), "data.sqlite");
const db = new sqlite3.Database(dbPath);

// Create tables if not exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS strava_connections (
      athlete_id INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER,
      athlete_firstname TEXT,
      athlete_lastname TEXT,
      slack_user_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add slack_user_id column if it doesn't exist (migration for existing databases)
  db.run(`
    ALTER TABLE strava_connections ADD COLUMN slack_user_id TEXT
  `, (err) => {
    // Ignore error if column already exists
    if (err && !err.message.includes('duplicate column')) {
      console.error('Migration error:', err);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS posted_activities (
      activity_id INTEGER PRIMARY KEY,
      athlete_id INTEGER,
      posted_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

export function upsertConnection({
  athlete_id,
  refresh_token,
  access_token,
  expires_at,
  athlete_firstname,
  athlete_lastname,
  slack_user_id,
}) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO strava_connections
        (athlete_id, refresh_token, access_token, expires_at, athlete_firstname, athlete_lastname, slack_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(athlete_id) DO UPDATE SET
        refresh_token=excluded.refresh_token,
        access_token=excluded.access_token,
        expires_at=excluded.expires_at,
        athlete_firstname=excluded.athlete_firstname,
        athlete_lastname=excluded.athlete_lastname,
        slack_user_id=COALESCE(excluded.slack_user_id, slack_user_id),
        updated_at=datetime('now')
      `,
      [
        athlete_id,
        refresh_token,
        access_token,
        expires_at,
        athlete_firstname,
        athlete_lastname,
        slack_user_id,
      ],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

export function getConnection(athlete_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM strava_connections WHERE athlete_id = ?`,
      [athlete_id],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

export function listConnections() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT athlete_id, athlete_firstname, athlete_lastname, slack_user_id, updated_at FROM strava_connections ORDER BY updated_at DESC`,
      [],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
}

export function markActivityPosted(activity_id, athlete_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO posted_activities(activity_id, athlete_id) VALUES (?, ?)`,
      [activity_id, athlete_id],
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}

export function wasActivityPosted(activity_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT activity_id FROM posted_activities WHERE activity_id = ?`,
      [activity_id],
      (err, row) => (err ? reject(err) : resolve(!!row))
    );
  });
}

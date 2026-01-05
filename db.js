import pg from "pg";
import sqlite3 from "sqlite3";
import path from "path";

const { Pool } = pg;

// Use PostgreSQL if DATABASE_URL is set (production), otherwise SQLite (local dev)
const usePostgres = !!process.env.DATABASE_URL;

let pool;
let db;

if (usePostgres) {
  console.log("Using PostgreSQL database");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strava_connections (
      athlete_id BIGINT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at BIGINT,
      athlete_firstname TEXT,
      athlete_lastname TEXT,
      slack_user_id TEXT,
      verified BOOLEAN DEFAULT FALSE,
      verification_token TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posted_activities (
      activity_id BIGINT PRIMARY KEY,
      athlete_id BIGINT,
      posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add verified and verification_token columns if they don't exist
  try {
    await pool.query(`
      ALTER TABLE strava_connections
      ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS verification_token TEXT
    `);
    console.log("Database migration: Added verified and verification_token columns");
  } catch (err) {
    // Columns might already exist, ignore error
    console.log("Database migration check:", err.message);
  }
} else {
  console.log("Using SQLite database");
  const dbPath = path.resolve(process.cwd(), "data.sqlite");
  db = new sqlite3.Database(dbPath);

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
        verified INTEGER DEFAULT 0,
        verification_token TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS posted_activities (
        activity_id INTEGER PRIMARY KEY,
        athlete_id INTEGER,
        posted_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Migration: Add verified and verification_token columns if they don't exist
    db.run(`
      ALTER TABLE strava_connections ADD COLUMN verified INTEGER DEFAULT 0
    `, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error("Migration error (verified):", err.message);
      } else if (!err) {
        console.log("Database migration: Added verified column");
      }
    });

    db.run(`
      ALTER TABLE strava_connections ADD COLUMN verification_token TEXT
    `, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error("Migration error (verification_token):", err.message);
      } else if (!err) {
        console.log("Database migration: Added verification_token column");
      }
    });
  });
}

export async function upsertConnection({
  athlete_id,
  refresh_token,
  access_token,
  expires_at,
  athlete_firstname,
  athlete_lastname,
  slack_user_id,
  verification_token,
}) {
  if (usePostgres) {
    const query = `
      INSERT INTO strava_connections
        (athlete_id, refresh_token, access_token, expires_at, athlete_firstname, athlete_lastname, slack_user_id, verification_token, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      ON CONFLICT(athlete_id) DO UPDATE SET
        refresh_token=$2,
        access_token=$3,
        expires_at=$4,
        athlete_firstname=$5,
        athlete_lastname=$6,
        slack_user_id=COALESCE($7, strava_connections.slack_user_id),
        verification_token=COALESCE($8, strava_connections.verification_token),
        updated_at=CURRENT_TIMESTAMP
    `;
    await pool.query(query, [
      athlete_id,
      refresh_token,
      access_token,
      expires_at,
      athlete_firstname,
      athlete_lastname,
      slack_user_id,
      verification_token,
    ]);
  } else {
    return new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO strava_connections
          (athlete_id, refresh_token, access_token, expires_at, athlete_firstname, athlete_lastname, slack_user_id, verification_token, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(athlete_id) DO UPDATE SET
          refresh_token=excluded.refresh_token,
          access_token=excluded.access_token,
          expires_at=excluded.expires_at,
          athlete_firstname=excluded.athlete_firstname,
          athlete_lastname=excluded.athlete_lastname,
          slack_user_id=COALESCE(excluded.slack_user_id, slack_user_id),
          verification_token=COALESCE(excluded.verification_token, verification_token),
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
          verification_token,
        ],
        (err) => (err ? reject(err) : resolve(true))
      );
    });
  }
}

export async function getConnection(athlete_id) {
  if (usePostgres) {
    const result = await pool.query(
      `SELECT * FROM strava_connections WHERE athlete_id = $1`,
      [athlete_id]
    );
    return result.rows[0] || null;
  } else {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM strava_connections WHERE athlete_id = ?`,
        [athlete_id],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });
  }
}

export async function listConnections() {
  if (usePostgres) {
    const result = await pool.query(
      `SELECT athlete_id, athlete_firstname, athlete_lastname, slack_user_id, updated_at
       FROM strava_connections
       ORDER BY updated_at DESC`
    );
    return result.rows;
  } else {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT athlete_id, athlete_firstname, athlete_lastname, slack_user_id, updated_at FROM strava_connections ORDER BY updated_at DESC`,
        [],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  }
}

export async function markActivityPosted(activity_id, athlete_id) {
  if (usePostgres) {
    await pool.query(
      `INSERT INTO posted_activities(activity_id, athlete_id)
       VALUES ($1, $2)
       ON CONFLICT(activity_id) DO NOTHING`,
      [activity_id, athlete_id]
    );
  } else {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT OR IGNORE INTO posted_activities(activity_id, athlete_id) VALUES (?, ?)`,
        [activity_id, athlete_id],
        (err) => (err ? reject(err) : resolve(true))
      );
    });
  }
}

export async function wasActivityPosted(activity_id) {
  if (usePostgres) {
    const result = await pool.query(
      `SELECT activity_id FROM posted_activities WHERE activity_id = $1`,
      [activity_id]
    );
    return result.rows.length > 0;
  } else {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT activity_id FROM posted_activities WHERE activity_id = ?`,
        [activity_id],
        (err, row) => (err ? reject(err) : resolve(!!row))
      );
    });
  }
}

export async function verifySlackUser(verification_token) {
  if (usePostgres) {
    const result = await pool.query(
      `UPDATE strava_connections SET verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING athlete_id`,
      [verification_token]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } else {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE strava_connections SET verified = 1, verification_token = NULL WHERE verification_token = ?`,
        [verification_token],
        function (err) {
          if (err) return reject(err);
          if (this.changes > 0) {
            db.get(
              `SELECT athlete_id FROM strava_connections WHERE verified = 1 ORDER BY updated_at DESC LIMIT 1`,
              [],
              (err, row) => (err ? reject(err) : resolve(row))
            );
          } else {
            resolve(null);
          }
        }
      );
    });
  }
}

export async function getConnectionByVerificationToken(token) {
  if (usePostgres) {
    const result = await pool.query(
      `SELECT * FROM strava_connections WHERE verification_token = $1`,
      [token]
    );
    return result.rows[0] || null;
  } else {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM strava_connections WHERE verification_token = ?`,
        [token],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });
  }
}

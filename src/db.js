const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'securescan.db');

let _db = null;

// ─── Load or create the database ─────────────────────────────
async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  // Make sure data/ folder exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load existing DB file or create fresh one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  createTables();
  return _db;
}

// ─── Save DB to disk (call after every write) ─────────────────
function saveDb() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── Create tables if they don't exist ────────────────────────
function createTables() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS scans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      github_login     TEXT NOT NULL,
      repo_full_name   TEXT NOT NULL,
      last_commit_sha  TEXT,
      scanned_at       TEXT NOT NULL,
      result           TEXT,
      file_summaries   TEXT,
      UNIQUE(github_login, repo_full_name)
    )
  `);
  saveDb();
}

// ─── Get a scan by repo ────────────────────────────────────────
async function getScan(githubLogin, repoFullName) {
  const db = await getDb();
  const stmt = db.prepare(
    'SELECT * FROM scans WHERE github_login = :login AND repo_full_name = :repo'
  );
  const result = stmt.getAsObject({ ':login': githubLogin, ':repo': repoFullName });
  stmt.free();

  if (!result.id) return null;

  return {
    ...result,
    result: result.result ? JSON.parse(result.result) : null,
    file_summaries: result.file_summaries ? JSON.parse(result.file_summaries) : null,
  };
}

// ─── Save or update a scan ────────────────────────────────────
async function saveScan({ githubLogin, repoFullName, lastCommitSha, result, fileSummaries }) {
  const db = await getDb();

  db.run(`
    INSERT INTO scans (github_login, repo_full_name, last_commit_sha, scanned_at, result, file_summaries)
    VALUES (:login, :repo, :sha, :scanned_at, :result, :summaries)
    ON CONFLICT(github_login, repo_full_name) DO UPDATE SET
      last_commit_sha = excluded.last_commit_sha,
      scanned_at      = excluded.scanned_at,
      result          = excluded.result,
      file_summaries  = excluded.file_summaries
  `, {
    ':login':      githubLogin,
    ':repo':       repoFullName,
    ':sha':        lastCommitSha,
    ':scanned_at': new Date().toISOString(),
    ':result':     JSON.stringify(result),
    ':summaries':  JSON.stringify(fileSummaries),
  });

  saveDb();
}

// ─── Get just the commit SHA for rescan check ─────────────────
async function getLastCommitSha(githubLogin, repoFullName) {
  const db = await getDb();
  const stmt = db.prepare(
    'SELECT last_commit_sha FROM scans WHERE github_login = :login AND repo_full_name = :repo'
  );
  const row = stmt.getAsObject({ ':login': githubLogin, ':repo': repoFullName });
  stmt.free();
  return row.last_commit_sha || null;
}

// ─── Get all scanned repos for a user (for repos page badges) ─
async function getUserScans(githubLogin) {
  const db = await getDb();
  const stmt = db.prepare(
    'SELECT repo_full_name, scanned_at, result FROM scans WHERE github_login = :login'
  );
  const rows = [];
  stmt.bind({ ':login': githubLogin });
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      repo_full_name: row.repo_full_name,
      scanned_at: row.scanned_at,
      risk_level: row.result ? JSON.parse(row.result).risk_level : null,
    });
  }
  stmt.free();
  return rows;
}

module.exports = { getDb, getScan, saveScan, getLastCommitSha, getUserScans };
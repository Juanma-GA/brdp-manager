import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../data/brdp.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// Ensure data directory exists
mkdirSync(join(__dirname, '../../data'), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Run schema
const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS above is a no-op on an already-existing table,
// so a new column needs its own idempotent migration -- ALTER TABLE ADD
// COLUMN isn't safe to just re-run unconditionally (fails on the second
// startup with "duplicate column name").
const ruleApprovalsCols = db.prepare("PRAGMA table_info(rule_approvals)").all().map(c => c.name);
if (!ruleApprovalsCols.includes('status')) {
  db.exec("ALTER TABLE rule_approvals ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
}

export default db;

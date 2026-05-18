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

export default db;

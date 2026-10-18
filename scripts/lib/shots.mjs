// Where the browser scripts write their screenshots and scratch files:
// SHOTS_DIR when set, else the system's temporary directory (Protecciones
// 1c: "/tmp" does not exist on Windows). Paths are built with path.join,
// never with a hand-written "/".
import os from 'node:os';
import path from 'node:path';

export const SHOTS_DIR = process.env.SHOTS_DIR || os.tmpdir();

export function shot(name) {
  return path.join(SHOTS_DIR, name);
}

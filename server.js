import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import db from './src/db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env manually (ESM compatible)
try {
  const envFile = readFileSync(join(__dirname, '.env'), 'utf-8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
} catch {
  // .env not found, continue with existing env vars
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve Vite build
app.use(express.static(join(__dirname, 'dist')));

// Proxy endpoint — receives { targetEndpoint, apiKey, provider, payload } from llmAPI.js
app.post('/api/proxy', async (req, res) => {
  const { targetEndpoint, apiKey, provider, payload } = req.body;

  if (!targetEndpoint || !apiKey || !payload) {
    return res.status(400).json({ error: 'Missing required fields: targetEndpoint, apiKey, payload' });
  }

  // Build auth headers only — payload already built by llmAPI.js
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'Anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // TEMP DEBUG — remove once the connection issue is confirmed fixed
  const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '***';
  console.log('[/api/proxy] →', targetEndpoint, {
    provider,
    headers: { ...headers, Authorization: headers.Authorization ? `Bearer ${maskedKey}` : undefined, 'x-api-key': headers['x-api-key'] ? maskedKey : undefined },
  });

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[/api/proxy] upstream error', response.status, errText);
      return res.status(response.status).send(errText);
    }

    // Pipe response back to client (handles both streaming and non-streaming)
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
      return pump();
    };
    await pump();

  } catch (err) {
    // Surface the real network-level failure (DNS, TLS, connection refused, etc.)
    // instead of letting it collapse into a generic message downstream.
    console.error('[/api/proxy] fetch failed:', err.code || err.name, err.message, err.cause || '');
    res.status(502).json({
      error: 'Upstream request failed',
      code: err.code || err.cause?.code || err.name,
      message: err.message,
    });
  }
});

// ─── BRDPs ────────────────────────────────────────────────────────────────────

app.get('/api/brdps', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM brdps ORDER BY identifier ASC').all();
    const brdps = rows.map(row => ({
      ...row,
      comment: row.comments,
      history: JSON.parse(row.history || '[]'),
    }));
    res.json(brdps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brdps', (req, res) => {
  try {
    const { id, identifier, title, definition, proposal, validation, comments, comment, history } = req.body;
    db.prepare(`
      INSERT INTO brdps (id, identifier, title, definition, proposal, validation, comments, history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      identifier || id,
      title || '',
      definition || '',
      proposal || '',
      validation || 'Pending',
      comments || comment || '',
      JSON.stringify(history || [])
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/brdps/:id', (req, res) => {
  try {
    const { identifier, title, definition, proposal, validation, comments, comment, history } = req.body;
    db.prepare(`
      UPDATE brdps SET identifier=?, title=?, definition=?, proposal=?, validation=?, comments=?, history=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      identifier || req.params.id,
      title || '',
      definition || '',
      proposal || '',
      validation || 'Pending',
      comments || comment || '',
      JSON.stringify(history || []),
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/brdps/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM brdps WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/brdps', (req, res) => {
  try {
    db.prepare('DELETE FROM brdps').run();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Config ───────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const config = {};
    rows.forEach(row => {
      try { config[row.key] = JSON.parse(row.value); }
      catch { config[row.key] = row.value; }
    });
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const upsert = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    const upsertMany = db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(key, JSON.stringify(value));
      }
    });
    upsertMany(Object.entries(req.body));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const upsertMany = db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(key, value);
      }
    });
    upsertMany(Object.entries(req.body));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Notes ────────────────────────────────────────────────────────────────────

app.get('/api/notes/:brdpId', (req, res) => {
  try {
    const row = db.prepare('SELECT text FROM notes WHERE brdp_id=?').get(req.params.brdpId);
    res.json({ text: row ? row.text : '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:brdpId', (req, res) => {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO notes (brdp_id, text, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(req.params.brdpId, req.body.text || '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BRDP Manager running at http://localhost:${PORT}`);
});

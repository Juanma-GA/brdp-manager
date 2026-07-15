import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { validateXML } from 'xmllint-wasm';
import db from './src/db/database.js';

// Trust Windows' certificate store (corporate/ATEXIS root CAs included) so
// outbound HTTPS requests work out-of-the-box behind a TLS-inspecting
// corporate proxy — no manual NODE_EXTRA_CA_CERTS per machine. No-op on
// Linux/Mac.
//
// inject: '+' patches tls.createSecureContext (instead of the default
// `true` mode, which only patches https.globalAgent.options.ca and is
// never consulted by Node's native fetch/undici). The '+' mode is the one
// that actually reaches undici, since tls.connect() calls
// tls.createSecureContext() internally whenever no explicit secureContext
// is passed — which is how fetch() opens its TLS sockets.
if (process.platform === 'win32') {
  const winCa = (await import('win-ca/api/index.js')).default;
  winCa({ inject: '+' });
}

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

// ─── BREX XSD validation ───────────────────────────────────────────────────────

// Each S1000D issue ships its own self-contained schema set (main BREX schema
// + xlink/rdf/dc companions it xs:imports) under sources/. Sets are NOT
// interchangeable between issues -- always load all 4 files from the same folder.
const BREX_XSD_MAP = {
  '3.0.1': { dir: 'S3.0.1', main: 'brex.xsd' },
  '4.1': { dir: 'S4.1', main: 'brex4.1.xsd' },
  '4.2': { dir: 'S4.2', main: 'brex4.2.xsd' },
};

const _xsdSetCache = {};

function loadXsdSet(format) {
  if (_xsdSetCache[format]) return _xsdSetCache[format];
  const entry = BREX_XSD_MAP[format];
  if (!entry) return null;
  const base = join(__dirname, 'sources', entry.dir);
  const set = {
    main: readFileSync(join(base, entry.main), 'utf-8'),
    xlink: readFileSync(join(base, 'xlink.xsd'), 'utf-8'),
    rdf: readFileSync(join(base, 'rdf.xsd'), 'utf-8'),
    dc: readFileSync(join(base, 'dc.xsd'), 'utf-8'),
  };
  _xsdSetCache[format] = set;
  return set;
}

app.post('/api/validate-brex', async (req, res) => {
  const { xml, format } = req.body;

  if (!xml || !format) {
    return res.status(400).json({ error: 'Missing required fields: xml, format' });
  }

  let xsdSet;
  try {
    xsdSet = loadXsdSet(format);
  } catch (err) {
    console.error('[/api/validate-brex] failed to load XSD set for', format, err.message);
    return res.status(500).json({ error: `Could not load XSD schema files for format "${format}"` });
  }

  if (!xsdSet) {
    return res.status(400).json({ error: `Unknown format "${format}". Expected one of: 3.0.1, 4.1, 4.2` });
  }

  try {
    const result = await validateXML({
      xml: [{ fileName: 'generated.xml', contents: xml }],
      schema: [xsdSet.main],
      preload: [
        { fileName: 'xlink.xsd', contents: xsdSet.xlink },
        { fileName: 'rdf.xsd', contents: xsdSet.rdf },
        { fileName: 'dc.xsd', contents: xsdSet.dc },
      ],
    });

    const errors = (result.errors || []).map((e) => ({
      message: e.message,
      line: e.loc?.lineNumber ?? null,
      rawMessage: e.rawMessage,
    }));

    res.json({ valid: result.valid, errors });
  } catch (err) {
    console.error('[/api/validate-brex] xmllint failed:', err.message);
    res.status(500).json({ error: 'XSD validation failed to run', message: err.message });
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

// Cascades to rule_approvals -- it's a satellite table keyed by brdp_id with
// no FK/cascade declared in schema.sql, so deleting a BRDP without this
// leaves its approvals orphaned. If a future BRDP happens to reuse the same
// id (e.g. AI Extract's per-run-relative BRDP-EXT-NNNNN numbering restarting
// after a wipe), an orphaned row would silently reattach and be treated as
// a real approval for unrelated new content.
const deleteBrdpCascade = db.transaction((id) => {
  db.prepare('DELETE FROM rule_approvals WHERE brdp_id=?').run(id);
  db.prepare('DELETE FROM brdps WHERE id=?').run(id);
});

const deleteAllBrdpsCascade = db.transaction(() => {
  db.prepare('DELETE FROM rule_approvals').run();
  db.prepare('DELETE FROM brdps').run();
});

app.delete('/api/brdps/:id', (req, res) => {
  try {
    deleteBrdpCascade(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/brdps', (req, res) => {
  try {
    deleteAllBrdpsCascade();
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

// ─── Rule approvals ───────────────────────────────────────────────────────────

// Must be registered before the /:brdpId/:format route below -- both are
// 2-segment paths under /api/approvals, and Express matches in declaration
// order, so this literal-prefixed route needs to win first.
app.get('/api/approvals/format/:format', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT brdp_id, rule_xml, source, status, approved_at FROM rule_approvals WHERE format=?'
    ).all(req.params.format);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/approvals/:brdpId/:format', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT rule_xml, source, status, approved_at FROM rule_approvals WHERE brdp_id=? AND format=?'
    ).get(req.params.brdpId, req.params.format);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proposes (creates or overwrites) a candidate rule for review -- never
// approves directly. Used both by generators auto-proposing a fresh
// candidate and, in future, by manual "Generate & review rule" / AI Extract
// import flows. Always resets status to 'pending_review' and clears
// approved_at, even when overwriting an existing pending_review row with a
// newer proposal.
app.put('/api/approvals/:brdpId/:format', (req, res) => {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO rule_approvals (brdp_id, format, rule_xml, source, status, approved_at)
      VALUES (?, ?, ?, ?, 'pending_review', NULL)
    `).run(req.params.brdpId, req.params.format, req.body.ruleXml || '', req.body.source || 'llm');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transitions an existing pending_review row to approved. Only a status/
// timestamp flip -- never rewrites rule_xml/source, so approving always
// freezes exactly what was proposed.
app.post('/api/approvals/:brdpId/:format/approve', (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE rule_approvals SET status='approved', approved_at=datetime('now')
      WHERE brdp_id=? AND format=? AND status='pending_review'
    `).run(req.params.brdpId, req.params.format);
    if (result.changes === 0) {
      res.status(404).json({ error: 'No pending_review approval found for this BRDP/format.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/approvals/:brdpId/:format', (req, res) => {
  try {
    db.prepare('DELETE FROM rule_approvals WHERE brdp_id=? AND format=?').run(req.params.brdpId, req.params.format);
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

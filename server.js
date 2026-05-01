require('dotenv').config();

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL;
const OCR_ENABLED = String(process.env.OCR_ENABLED || 'true') === 'true';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add your Supabase PostgreSQL connection string in Render environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

const DEFAULT_SETTINGS = {
  name: 'RESTO', vat_no: '', address: '', city: '', currency: 'EUR',
  vat_pct: 10, service_charge: 0, invoice_prefix: 'INV-', footer: 'Thank you!'
};

const DEFAULT_STATE = {
  tables: [], menu: [], orders: [], invoices: [], employees: [], expenses: [], purchases: [], shifts: [], leaves: [], workhours: [],
  settings: DEFAULT_SETTINGS,
  lang: 'en',
  users: [
    { id: 1, email: 'owner@resto.com', passwordHash: bcrypt.hashSync('owner123', 10), role: 'owner', name: 'Owner Admin', color: '#f5a623', active: true }
  ]
};

let state = structuredCloneSafe(DEFAULT_STATE);
let dbReady = false;

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseUsers(users) {
  const source = Array.isArray(users) && users.length ? users : structuredCloneSafe(DEFAULT_STATE.users);
  return source.map((u, idx) => {
    const passwordHash = u.passwordHash || (u.pass ? bcrypt.hashSync(String(u.pass), 10) : bcrypt.hashSync(idx === 0 ? 'owner123' : 'changeme', 10));
    return {
      id: Number(u.id || idx + 1),
      email: String(u.email || '').trim().toLowerCase(),
      passwordHash,
      role: u.role || 'waiter',
      name: u.name || u.email || `User ${idx + 1}`,
      color: u.color || '#f5a623',
      active: u.active !== false
    };
  });
}

function normaliseState(input) {
  const out = { ...structuredCloneSafe(DEFAULT_STATE), ...input };
  out.settings = { ...DEFAULT_SETTINGS, ...(out.settings || {}) };
  out.users = normaliseUsers(out.users);
  return out;
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, name: u.name, color: u.color, active: u.active !== false };
}

function publicState() {
  const output = structuredCloneSafe(state);
  output.users = (output.users || []).map(publicUser);
  return output;
}

async function initDb() {
  await pool.query(`
    create table if not exists app_state (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    await pool.query(
      `insert into app_state (key, value) values ($1, $2::jsonb) on conflict (key) do nothing`,
      [key, JSON.stringify(value)]
    );
  }

  state = await loadStateFromDb();
  dbReady = true;
}

async function loadStateFromDb() {
  const rows = await pool.query('select key, value from app_state');
  const loaded = structuredCloneSafe(DEFAULT_STATE);
  for (const row of rows.rows) loaded[row.key] = row.value;
  return normaliseState(loaded);
}

async function saveKey(key, value) {
  await pool.query(
    `insert into app_state (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

async function saveMany(entries) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [key, value] of Object.entries(entries)) {
      await client.query(
        `insert into app_state (key, value, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function ownerOrSelf(req, userId) {
  return req.user.role === 'owner' || Number(req.user.id) === Number(userId);
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, mode: 'postgres-supabase', dbReady, time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  const user = (state.users || []).find(u => String(u.email).toLowerCase() === email);
  if (!user || user.active === false || !bcrypt.compareSync(pass, user.passwordHash || '')) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    state = await loadStateFromDb();
    res.json({ state: publicState(), serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Could not load app data', detail: err.message });
  }
});

app.get('/api/state/:key', authRequired, async (req, res) => {
  const key = req.params.key;
  try {
    const fresh = await pool.query('select value from app_state where key = $1', [key]);
    const value = fresh.rows.length ? fresh.rows[0].value : state[key];
    const publicValue = key === 'users' ? (value || []).map(publicUser) : value;
    res.json({ key, value: publicValue ?? null });
  } catch (err) {
    res.status(500).json({ error: 'Could not load state', detail: err.message });
  }
});

app.post('/api/state/:key', authRequired, async (req, res) => {
  const key = req.params.key;
  if (!(key in DEFAULT_STATE) && !key.startsWith('seq_')) return res.status(400).json({ error: 'Unsupported state key' });

  try {
    let value = req.body.value;
    if (key === 'users') {
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can manage users' });
      const existing = state.users || [];
      value = (Array.isArray(value) ? value : []).map((u, idx) => {
        const old = existing.find(x => Number(x.id) === Number(u.id) || String(x.email).toLowerCase() === String(u.email).toLowerCase());
        return {
          id: Number(u.id || Date.now() + idx),
          email: String(u.email || '').trim().toLowerCase(),
          passwordHash: u.pass && u.pass !== '********' ? bcrypt.hashSync(String(u.pass), 10) : (old?.passwordHash || bcrypt.hashSync('changeme', 10)),
          role: u.role || old?.role || 'waiter',
          name: u.name || old?.name || u.email,
          color: u.color || old?.color || '#f5a623',
          active: u.active !== false
        };
      });
    }

    state[key] = value;
    await saveKey(key, value);
    const publicValue = key === 'users' ? value.map(publicUser) : value;
    io.emit('state:update', { key, value: publicValue, updatedBy: req.user.email, at: new Date().toISOString() });
    res.json({ ok: true, key, value: publicValue });
  } catch (err) {
    res.status(500).json({ error: 'Could not save state', detail: err.message });
  }
});

app.post('/api/import-state', authRequired, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can import backups' });
  const incoming = normaliseState(req.body.state || req.body || {});
  try {
    state = incoming;
    await saveMany(state);
    io.emit('state:reload', { updatedBy: req.user.email, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not import state', detail: err.message });
  }
});

app.post('/api/users/:id/password', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!ownerOrSelf(req, id)) return res.status(403).json({ error: 'Not allowed' });
  const user = (state.users || []).find(u => Number(u.id) === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (req.user.role !== 'owner' && !bcrypt.compareSync(oldPassword, user.passwordHash || '')) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  try {
    user.passwordHash = bcrypt.hashSync(newPassword, 10);
    await saveKey('users', state.users);
    io.emit('state:update', { key: 'users', value: state.users.map(publicUser), updatedBy: req.user.email, at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not change password', detail: err.message });
  }
});

app.post('/api/ocr', authRequired, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let rawText = '';
  try {
    if (OCR_ENABLED && req.file.mimetype && req.file.mimetype.startsWith('image/')) {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng');
      const result = await worker.recognize(req.file.path);
      rawText = result?.data?.text || '';
      await worker.terminate();
    }
  } catch (err) {
    console.error('OCR failed:', err.message);
    rawText = '';
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  const fields = parseReceiptText(rawText);
  res.json({ rawText, fields, note: rawText ? 'OCR completed' : 'OCR did not extract text; enter fields manually.' });
});

function parseReceiptText(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const money = (String(text || '').match(/(?:€|EUR)?\s*(\d+[\.,]\d{2})/g) || [])
    .map(v => Number(v.replace(/[^0-9,.]/g, '').replace(',', '.')))
    .filter(n => !Number.isNaN(n));
  const total = money.length ? Math.max(...money) : 0;
  const dateMatch = String(text || '').match(/(\d{4}-\d{2}-\d{2}|\d{2}[./-]\d{2}[./-]\d{4})/);
  let date = new Date().toISOString().slice(0,10);
  if (dateMatch) {
    const d = dateMatch[1];
    if (/^\d{4}/.test(d)) date = d;
    else {
      const [dd, mm, yyyy] = d.split(/[./-]/);
      date = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
  }
  const invMatch = String(text || '').match(/(?:invoice|inv|receipt|bill)\s*[:#-]?\s*([A-Z0-9-]+)/i);
  return {
    supplier: lines[0] || 'Supplier Name',
    invNo: invMatch ? invMatch[1] : 'INV-0001',
    date,
    payment: /card|visa|mastercard/i.test(text) ? 'Card' : 'Cash',
    subtotal: 0,
    vat: 0,
    total,
    notes: ''
  };
}

io.on('connection', socket => {
  socket.emit('connected', { ok: true, time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`RESTO PRO Supabase/PostgreSQL backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname);
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'resto-data.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const OCR_ENABLED = String(process.env.OCR_ENABLED || 'true') === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 12 * 1024 * 1024 } });

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

let state = loadState();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return normaliseState({ ...DEFAULT_STATE, ...parsed });
    }
  } catch (err) {
    console.error('Could not read data file:', err.message);
  }
  const fresh = normaliseState(structuredCloneSafe(DEFAULT_STATE));
  saveState(fresh);
  return fresh;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseState(input) {
  const out = { ...structuredCloneSafe(DEFAULT_STATE), ...input };
  out.users = Array.isArray(out.users) && out.users.length ? out.users : structuredCloneSafe(DEFAULT_STATE.users);
  out.users = out.users.map((u, idx) => {
    const passwordHash = u.passwordHash || (u.pass ? bcrypt.hashSync(String(u.pass), 10) : bcrypt.hashSync(idx === 0 ? 'owner123' : 'changeme', 10));
    const copy = {
      id: Number(u.id || idx + 1),
      email: String(u.email || '').toLowerCase(),
      passwordHash,
      role: u.role || 'waiter',
      name: u.name || u.email || `User ${idx + 1}`,
      color: u.color || '#f5a623',
      active: u.active !== false
    };
    return copy;
  });
  return out;
}

function saveState(nextState = state) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, name: u.name, color: u.color, active: u.active !== false };
}

function publicState() {
  const output = structuredCloneSafe(state);
  output.users = (output.users || []).map(publicUser);
  return output;
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

app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'json-db-cloud', dataFile: DATA_FILE, time: new Date().toISOString() }));

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

app.get('/api/bootstrap', (req, res) => {
  res.json({ state: publicState(), serverTime: new Date().toISOString() });
});

app.get('/api/state/:key', authRequired, (req, res) => {
  const key = req.params.key;
  const value = key === 'users' ? (state.users || []).map(publicUser) : state[key];
  res.json({ key, value: value ?? null });
});

app.post('/api/state/:key', authRequired, (req, res) => {
  const key = req.params.key;
  if (!(key in DEFAULT_STATE) && !key.startsWith('seq_')) return res.status(400).json({ error: 'Unsupported state key' });

  let value = req.body.value;
  if (key === 'users') {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can manage users' });
    const existing = state.users || [];
    value = (Array.isArray(value) ? value : []).map((u, idx) => {
      const old = existing.find(x => Number(x.id) === Number(u.id) || String(x.email).toLowerCase() === String(u.email).toLowerCase());
      return {
        id: Number(u.id || Date.now() + idx),
        email: String(u.email || '').toLowerCase(),
        passwordHash: u.pass && u.pass !== '********' ? bcrypt.hashSync(String(u.pass), 10) : (old?.passwordHash || bcrypt.hashSync('changeme', 10)),
        role: u.role || old?.role || 'waiter',
        name: u.name || old?.name || u.email,
        color: u.color || old?.color || '#f5a623',
        active: u.active !== false
      };
    });
  }

  state[key] = value;
  saveState();
  const publicValue = key === 'users' ? value.map(publicUser) : value;
  io.emit('state:update', { key, value: publicValue, updatedBy: req.user.email, at: new Date().toISOString() });
  res.json({ ok: true, key, value: publicValue });
});

app.post('/api/users/:id/password', authRequired, (req, res) => {
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
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveState();
  io.emit('state:update', { key: 'users', value: state.users.map(publicUser), updatedBy: req.user.email, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/ocr', authRequired, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let rawText = '';
  try {
    if (OCR_ENABLED && req.file.mimetype.startsWith('image/')) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RESTO PRO cloud backend running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
});

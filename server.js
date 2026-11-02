import express from 'express';
import multer from 'multer';
import cors from 'cors';
import QRCode from 'qrcode';
import { customAlphabet } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const MAX_BYTES = Number(process.env.MAX_BYTES || 200 * 1024 * 1024); // 200 MB
const TTL_MS = Number(process.env.TTL_MS || 24 * 60 * 60 * 1000); // 24h
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const META_FILE = path.join(UPLOAD_DIR, 'meta.json');
const CODE_LEN = 6;
const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_LEN);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** @type {Record<string, {code:string, files:Array<{name:string,stored:string,size:number}>, created:number, expires:number}>} */
let store = {};

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      store = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    }
  } catch {
    store = {};
  }
}

function saveMeta() {
  fs.writeFileSync(META_FILE, JSON.stringify(store));
}

function purgeExpired() {
  const now = Date.now();
  let changed = false;
  for (const [code, entry] of Object.entries(store)) {
    if (entry.expires <= now) {
      for (const f of entry.files || []) {
        const p = path.join(UPLOAD_DIR, f.stored);
        try { fs.unlinkSync(p); } catch {}
      }
      delete store[code];
      changed = true;
    }
  }
  if (changed) saveMeta();
}

loadMeta();
purgeExpired();
setInterval(purgeExpired, 5 * 60 * 1000).unref();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 20 },
});

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function publicBase(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, maxBytes: MAX_BYTES, ttlMs: TTL_MS });
});

app.get('/api/config', (_req, res) => {
  res.json({
    maxBytes: MAX_BYTES,
    maxMb: Math.round(MAX_BYTES / (1024 * 1024)),
    ttlHours: Math.round(TTL_MS / (60 * 60 * 1000)),
  });
});

app.post('/api/upload', (req, res) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Файл слишком большой (лимит ${Math.round(MAX_BYTES / (1024 * 1024))} МБ)`
        : err.message || 'Ошибка загрузки';
      return res.status(400).json({ error: msg });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Выберите хотя бы один файл' });
    }

    purgeExpired();
    let code = genCode();
    while (store[code]) code = genCode();

    const now = Date.now();
    const entry = {
      code,
      created: now,
      expires: now + TTL_MS,
      files: files.map((f) => ({
        name: f.originalname || 'file',
        stored: f.filename,
        size: f.size,
      })),
    };
    store[code] = entry;
    saveMeta();

    const base = publicBase(req);
    const link = `${base}/d/${code}`;
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(link, { margin: 1, width: 280 });
    } catch {}

    res.json({
      code,
      link,
      qrDataUrl,
      expiresAt: entry.expires,
      files: entry.files.map((f) => ({ name: f.name, size: f.size })),
    });
  });
});

app.get('/api/info/:code', (req, res) => {
  purgeExpired();
  const code = String(req.params.code || '').toUpperCase();
  const entry = store[code];
  if (!entry) return res.status(404).json({ error: 'Код не найден или срок истёк' });
  res.json({
    code,
    expiresAt: entry.expires,
    files: entry.files.map((f) => ({ name: f.name, size: f.size })),
  });
});

function sendDownload(req, res) {
  purgeExpired();
  const code = String(req.params.code || '').toUpperCase();
  const entry = store[code];
  if (!entry) return res.status(404).json({ error: 'Код не найден или срок истёк' });

  const idx = req.params.index != null ? Number(req.params.index) : 0;
  if (!Number.isInteger(idx) || idx < 0 || idx >= entry.files.length) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  const file = entry.files[idx];
  const full = path.join(UPLOAD_DIR, file.stored);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Файл отсутствует на сервере' });
  }
  res.download(full, file.name);
}

app.get('/api/download/:code', sendDownload);
app.get('/api/download/:code/:index', sendDownload);

// Pretty download page route — SPA handles /d/:code
app.get('/d/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`filedrop listening on ${PORT}, max=${MAX_BYTES} ttl=${TTL_MS}`);
});

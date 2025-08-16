// server.js
// ============================================================================
// FantaElite Backend - API + PDF
// Endpoints:
//   GET  /health
//   POST /api/test-generate       -> ritorna JSON con la rosa
//   POST /api/generate            -> genera e restituisce il PDF come download
//
// Variabili d'ambiente (senza virgolette):
//   PORT=3000
//   PUBLIC_URL=http://localhost:3000
//   API_KEY=abc123!fantaElite2025      (chiave interna per test/manuale)
//   OPENAI_API_KEY=sk-...              (chiave standard) OPPURE sk-proj-...
//   OPENAI_MODEL=gpt-4o-mini
//   OPENAI_PROJECT=prj_xxx             (se usi sk-proj-... serve questo header)
//   KOFI_VERIFICATION_TOKEN=...        (opzionale; webhook non obbligatorio qui)
//   RESEND_API_KEY=...                 (opzionale; per invio email)
//   FROM_EMAIL="FantaElite <mail@dominio.it>" (opzionale)
//
// Avvio consigliato (carica .env automaticamente):
//   node --env-file=.env server.js
// ============================================================================

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

// Carica .env se presente (non è obbligatorio se usi --env-file)
try {
  const { config } = await import('dotenv');
  config();
} catch { /* ok se non c'è dotenv */ }

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const PORT        = process.env.PORT || 3000;
const PUBLIC_URL  = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY     = process.env.API_KEY || 'abc123!fantaElite2025';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''; // solo se usi sk-proj-...

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Cartella output PDF
const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// PDFKit
import PDFDocument from 'pdfkit';

// ----------------------------------------------------------------------------
const app = express();

// CORS base
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // per test locale
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Body parser JSON
app.use(express.json({ limit: '1mb' }));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function logStartupWarnings() {
  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  if (!KOFI_VERIFICATION_TOKEN) {
    console.warn('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi (opzionale).');
  }
  if (!OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY mancante: userò roster di fallback statico.');
  } else {
    const kind = OPENAI_API_KEY.startsWith('sk-proj-') ? 'sk-proj (project key)' : 'standard sk';
    console.log(`ℹ️  OpenAI configurato (${kind}) • model=${OPENAI_MODEL}${OPENAI_PROJECT ? ` • project=${OPENAI_PROJECT}` : ''}`);
  }
  console.log(`📂 Cartella PDF: ${OUT_DIR}`);
}

function requireAuth(req, res) {
  const hdr = req.headers['authorization'] || '';
  const ok = hdr === `Bearer ${API_KEY}`;
  if (!ok) {
    res.status(401).json({ error: 'Unauthorized. Header Authorization mancante o errato.' });
    return false;
  }
  return true;
}

// Pulisce un contenuto AI per estrarre JSON valido
function extractJsonFromText(txt) {
  if (!txt) return null;
  // ```json ... ```
  const codeFence = txt.match(/```(?:json)?([\s\S]*?)```/i);
  if (codeFence) {
    try { return JSON.parse(codeFence[1]); } catch { /* continue */ }
  }
  // dal primo { all’ultima }
  const first = txt.indexOf('{');
  const last  = txt.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const maybe = txt.slice(first, last + 1);
    try { return JSON.parse(maybe); } catch { /* continue */ }
  }
  // tentativo diretto
  try { return JSON.parse(txt); } catch { return null; }
}

function fallbackRoster(mode, min, max) {
  const base = [
    { ruolo: 'P', nome: 'Portiere Solidissimo',  costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino',     costo: 18 },
    { ruolo: 'D', nome: 'Centrale Affidabile',  costo: 22 },
    { ruolo: 'C', nome: 'Regista Tecnico',      costo: 40 },
    { ruolo: 'C', nome: 'Mezzala Inserimenti',  costo: 32 },
    { ruolo: 'A', nome: 'Prima Punta Bomber',   costo: 120 },
    { ruolo: 'A', nome: 'Esterno Rapido',       costo: 50 },
  ];
  const totale = base.reduce((s, x) => s + (x.costo || 0), 0);
  return {
    mode,
    budget: { min, max },
    totale,
    rosa: base,
    note: 'Roster di esempio (fallback). Configura OPENAI_API_KEY per generazione AI.'
  };
}

// --- INCOLLO QUI IL TUO BLOCCO (callOpenAI), invariato ---
// Usa fetch nativo di Node >=18
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY assente');
  }

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (OPENAI_PROJECT) {
    headers['OpenAI-Project'] = OPENAI_PROJECT; // <- necessario con sk-proj-...
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
// --- FINE BLOCCO ---

async function generateRoster({ mode, budgetMin, budgetMax, email }) {
  // Prompt stretto: vogliamo SOLO JSON valido
  const sys = {
    role: 'system',
    content:
      'Sei un assistente che genera una rosa di fantacalcio in formato JSON **valido**. Rispondi solo con JSON.'
  };
  const usr = {
    role: 'user',
    content: `
Genera una rosa per Fantacalcio con stile "${mode}" e budget tra ${budgetMin}-${budgetMax}.
Formato JSON esatto:
{
  "mode": "...",
  "budget": {"min": ${budgetMin}, "max": ${budgetMax}},
  "totale": 123,
  "rosa": [
    {"ruolo": "P", "nome": "...", "costo": 10},
    {"ruolo": "D", "nome": "...", "costo": 15}
  ],
  "note": "breve nota (max 180 caratteri)"
}
Regole:
- "rosa" deve contenere almeno 7 giocatori (P/D/C/A), con "costo" numerico >= 1.
- Il campo "totale" = somma dei "costo".
- Output SOLO JSON valido, senza testo extra.
`.trim()
  };

  try {
    const content = await callOpenAI([sys, usr]);
    const json = extractJsonFromText(content);
    if (!json || !Array.isArray(json.rosa)) throw new Error('JSON AI non valido');

    // Normalizzazione & controlli
    json.mode = json.mode || mode;
    json.budget = json.budget || { min: budgetMin, max: budgetMax };
    json.totale = Number.isFinite(json.totale)
      ? json.totale
      : json.rosa.reduce((s, x) => s + (Number(x.costo) || 0), 0);

    return {
      mode: String(json.mode),
      budget: { min: Number(json.budget.min), max: Number(json.budget.max) },
      totale: Number(json.totale),
      rosa: json.rosa.map(x => ({
        ruolo: String(x.ruolo || '').toUpperCase(),
        nome : String(x.nome || 'Giocatore'),
        costo: Number(x.costo || 1),
      })),
      note: String(json.note || '')
    };
  } catch (err) {
    console.error('⚠️  generateRoster -> errore AI, uso fallback:', err.message);
    return fallbackRoster(mode, budgetMin, budgetMax);
  }
}

function fmtEuro(num) { return `${num} crediti`; }

function drawHeader(doc, titolo, sub) {
  doc
    .fontSize(20).text(titolo, { align: 'center' })
    .moveDown(0.3)
    .fontSize(11).fillColor('#555').text(sub, { align: 'center' })
    .fillColor('#000')
    .moveDown(1);
}
function drawTable(doc, rows) {
  const startX = 50;
  let   y      = doc.y;
  const colW = [60, 330, 100]; // Ruolo, Nome, Costo

  // Header
  doc
    .fontSize(12)
    .fillColor('#222')
    .text('Ruolo', startX, y, { width: colW[0] })
    .text('Giocatore', startX + colW[0], y, { width: colW[1] })
    .text('Costo', startX + colW[0] + colW[1], y, { width: colW[2], align: 'right' })
    .moveDown(0.4);
  y = doc.y;

  // Separatore
  doc.moveTo(startX, y).lineTo(startX + colW[0] + colW[1] + colW[2], y).strokeColor('#999').lineWidth(0.5).stroke();
  y += 6;

  // Rows
  doc.fontSize(11).strokeColor('#ddd');
  for (const r of rows) {
    const lineY = y + 16;
    doc
      .fillColor('#000')
      .text(r.ruolo, startX, y, { width: colW[0] })
      .text(r.nome,  startX + colW[0], y, { width: colW[1] })
      .text(fmtEuro(r.costo), startX + colW[0] + colW[1], y, { width: colW[2], align: 'right' });
    doc.moveTo(startX, lineY).lineTo(startX + colW[0] + colW[1] + colW[2], lineY).stroke();
    y = lineY + 4;
  }
  doc.moveDown(1);
}

async function buildPdf({ mode, budget, totale, rosa, note }) {
  return new Promise((resolve, reject) => {
    const safeMode = (mode || 'equilibrata').toLowerCase();
    const fileName = `FantaElite_${safeMode}_${Date.now()}.pdf`;
    const filePath = path.join(OUT_DIR, fileName);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    drawHeader(
      doc,
      `FantaElite — Rosa "${mode}"`,
      `Budget: ${budget.min}-${budget.max} crediti  •  Totale stimato: ${totale} crediti`
    );

    if (note) {
      doc.fontSize(12).fillColor('#333').text(note, { align: 'left' }).moveDown(0.8).fillColor('#000');
    }

    drawTable(doc, rosa);
    doc.fontSize(12).text(`Totale: ${fmtEuro(totale)}`, { align: 'right' }).moveDown(0.5);

    // Footer
    doc.fontSize(9).fillColor('#666')
      .text(`Generato con FantaElite • ${new Date().toLocaleString()} • ${PUBLIC_URL}`, 50, 780, { width: 495, align: 'center' });

    doc.end();
    stream.on('finish', () => resolve({ filePath, fileName }));
    stream.on('error', reject);
  });
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post('/api/test-generate', async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const { mode = 'equilibrata', email = 'tu@esempio.it', budgetMin = 380, budgetMax = 520 } = req.body || {};
    const data = await generateRoster({ mode, budgetMin, budgetMax, email });
    res.json({ ...data, email, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error('POST /api/test-generate error:', err);
    res.status(500).json({ error: 'Errore interno durante la generazione', details: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const { mode = 'equilibrata', email = 'tu@esempio.it', budgetMin = 380, budgetMax = 520 } = req.body || {};

    const data = await generateRoster({ mode, budgetMin, budgetMax, email });
    const pdf  = await buildPdf(data);

    // Restituisci direttamente il PDF come download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.fileName}"`);
    const s = fs.createReadStream(pdf.filePath);
    s.pipe(res);
    s.on('error', (e) => {
      console.error('Streaming PDF error:', e);
      res.status(500).end('Errore nel download del PDF');
    });
  } catch (err) {
    console.error('POST /api/generate error:', err);
    res.status(500).send('Errore interno durante la generazione');
  }
});

app.get('/', (req, res) => {
  res.type('text/plain').send('FantaElite backend attivo. Endpoints: /health, /api/test-generate, /api/generate');
});

// ----------------------------------------------------------------------------
// Avvio
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  logStartupWarnings();
});

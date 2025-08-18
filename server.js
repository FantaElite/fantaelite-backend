// server.js (ESM) — Backend FantaElite
// Avvio con:  node --env-file=.env server.js
// Dipendenze: npm i express morgan pdfkit uuid

import express from 'express';
import morgan from 'morgan';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';

// =========================
// ENV & CONFIG
// =========================
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'abc123!fantaElite2025';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''; // es: proj_xxxxx

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL     = process.env.FROM_EMAIL || 'FantaElite <no-reply@fantaelite.local>';

// =========================
// APP
// =========================
const app = express();
app.use(morgan('dev'));
app.use(express.json());

// =========================
/** LOG CHIARI ALL’AVVIO */
// =========================
const aiOn = !!OPENAI_API_KEY;
console.log(`🧠 Modalità AI: ${aiOn
  ? `OPENAI (${OPENAI_MODEL}${OPENAI_PROJECT ? `, project: ${OPENAI_PROJECT}` : ''})`
  : 'FALLBACK STATICO'}`);

if (!KOFI_VERIFICATION_TOKEN) {
  console.warn('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi.');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY mancante: verrà usato il roster di fallback statico.');
}

// =========================
// UTIL
// =========================
function requireApiKey(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function fallbackRoster() {
  return [
    { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino',    costo: 18 },
    { ruolo: 'D', nome: 'Centrale Affidabile', costo: 22 },
    { ruolo: 'C', nome: 'Regista Tecnico',     costo: 40 },
    { ruolo: 'C', nome: 'Mezzala Inserimenti', costo: 32 },
    { ruolo: 'A', nome: 'Prima Punta Bomber',  costo: 120 },
    { ruolo: 'A', nome: 'Esterno Rapido',      costo: 50 },
  ];
}

function estraiJson(text) {
  // Prova a trovare un array JSON nel testo
  const first = text.indexOf('[');
  const last  = text.lastIndexOf(']');
  if (first >= 0 && last > first) {
    const slice = text.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  // Tentativo diretto
  try { return JSON.parse(text); } catch {}
  throw new Error('Risposta OpenAI non in JSON valido');
}

// =========================
// OPENAI
// =========================
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY assente');
  }

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (OPENAI_PROJECT) {
    // Necessario quando si usano chiavi sk-proj-...
    headers['OpenAI-Project'] = OPENAI_PROJECT;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.7,
      messages,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function generateRosaAI({ mode, budgetMin, budgetMax }) {
  const system = {
    role: 'system',
    content: `Sei un assistente che costruisce una ROSA per fantacalcio con un budget in crediti.
- DEVI rispondere SOLO con un array JSON (nessun testo fuori dal JSON).
- Ogni elemento deve essere un oggetto con: "ruolo" (P|D|C|A), "nome" (stringa), "costo" (numero intero).
- La somma di "costo" deve rimanere tra ${budgetMin} e ${budgetMax}.
- Lo stile "${mode}" è una linea guida sulla distribuzione del budget (es. "equilibrata").`,
  };

  const user = {
    role: 'user',
    content:
`Genera una rosa rispettando:
- stile: ${mode}
- budgetMin: ${budgetMin}
- budgetMax: ${budgetMax}
Restituisci SOLO il JSON (array) senza spiegazioni.`,
  };

  const answer = await callOpenAI([system, user]);
  const arr = estraiJson(answer);

  if (!Array.isArray(arr) || !arr.length) {
    throw new Error('OpenAI ha restituito un array vuoto o non valido');
  }

  // Sanitizza minimi campi
  return arr.map(x => ({
    ruolo: String(x.ruolo || '').trim().toUpperCase(),
    nome:  String(x.nome  || '').trim(),
    costo: Math.max(0, parseInt(x.costo ?? 0, 10) || 0),
  }));
}

// =========================
// PDF
// =========================
function pdfFromRosa({ mode, email, budgetMin, budgetMax, createdAt }, rosa) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Header
    doc.fontSize(22).text(`FantaElite — Rosa ${String(mode).toUpperCase()}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666')
      .text(`Email: ${email || '-'}`)
      .text(`Budget: ${budgetMin} — ${budgetMax}`)
      .text(`Creato: ${new Date(createdAt || Date.now()).toLocaleString()}`);
    doc.moveDown();

    // Tabella semplice
    doc.fillColor('#000').fontSize(12).text('Giocatori:', { underline: true });
    doc.moveDown(0.5);

    let totale = 0;
    rosa.forEach((p, idx) => {
      totale += (p.costo || 0);
      doc.text(`${String(idx + 1).padStart(2, '0')}. [${p.ruolo}] ${p.nome} — ${p.costo} crediti`);
    });

    doc.moveDown();
    doc.font('Helvetica-Bold').text(`Totale: ${totale} crediti`, { align: 'right' });
    doc.font('Helvetica');
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666').text('Generato automaticamente da FantaElite', { align: 'center' });

    doc.end();
  });
}

// =========================
// ENDPOINTS
// =========================

// Salute
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Endpoint di debug OpenAI (risponde "pong" se l’AI funziona)
app.get('/debug/openai', async (req, res) => {
  try {
    const ans = await callOpenAI([
      { role: 'system', content: 'Rispondi SOLO "pong".' },
      { role: 'user',   content: 'ping' }
    ]);
    res.json({ ok: true, answer: ans });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Test-generate (JSON) — protetto da API KEY
app.post('/api/test-generate', requireApiKey, async (req, res) => {
  try {
    const { mode = 'equilibrata', email, budgetMin = 380, budgetMax = 520 } = req.body || {};
    const createdAt = new Date().toISOString();

    let rosa, note = 'Generato con AI';
    try {
      rosa = await generateRosaAI({ mode, budgetMin, budgetMax });
    } catch (aiErr) {
      console.warn('AI fallita, uso fallback:', aiErr?.message || aiErr);
      rosa = fallbackRoster();
      note = 'Roster di esempio (fallback). Configura OPENAI_API_KEY/PROJECT per generazione AI.';
    }

    const totale = rosa.reduce((s, x) => s + (x.costo || 0), 0);
    res.json({
      mode,
      budget: { min: budgetMin, max: budgetMax },
      totale,
      rosa,
      note,
      email,
      createdAt
    });
  } catch (e) {
    console.error('Errore /api/test-generate:', e);
    res.status(500).json({ error: 'Errore interno', details: String(e) });
  }
});

// Generate (PDF) — protetto da API KEY
app.post('/api/generate', requireApiKey, async (req, res) => {
  try {
    const { mode = 'equilibrata', email, budgetMin = 380, budgetMax = 520 } = req.body || {};
    const createdAt = new Date().toISOString();

    let rosa, note = 'Generato con AI';
    try {
      rosa = await generateRosaAI({ mode, budgetMin, budgetMax });
    } catch (aiErr) {
      console.warn('AI fallita, uso fallback:', aiErr?.message || aiErr);
      rosa = fallbackRoster();
      note = 'Roster di esempio (fallback). Configura OPENAI_API_KEY/PROJECT per generazione AI.';
    }

    const pdf = await pdfFromRosa({ mode, email, budgetMin, budgetMax, createdAt }, rosa);
    const safeMode = String(mode).replace(/[^a-z0-9_-]/gi, '_');
    const filename = `FantaElite_${safeMode}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Note', encodeURIComponent(note));
    res.send(pdf);
  } catch (e) {
    console.error('Errore /api/generate:', e);
    res.status(500).json({ error: 'Errore interno durante la generazione', details: String(e) });
  }
});

// (Facoltativo) Ko-fi webhook minimale — qui solo valida il token e risponde OK.
// Integra la tua logica ordini qui se necessario.
app.post('/kofi/webhook', express.json(), (req, res) => {
  const token = (req.body && (req.body.verification_token || req.body.verificationToken)) || '';
  if (!KOFI_VERIFICATION_TOKEN || token !== KOFI_VERIFICATION_TOKEN) {
    return res.status(403).json({ ok: false, error: 'Verification token non valido' });
  }
  // TODO: crea ticket, invia email, ecc.
  res.json({ ok: true });
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
});

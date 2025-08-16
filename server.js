import 'dotenv/config';
// server.js (ESM)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import PDFDocument from 'pdfkit';
import { Resend } from 'resend';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'abc123!fantaElite2025';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';

// ---- Utils ----
function log(...args) { if (LOG_LEVEL !== 'silent') console.log(...args); }
function logDebug(...args) { if (['debug', 'trace'].includes(LOG_LEVEL)) console.debug(...args); }
function logWarn(...args) { if (LOG_LEVEL !== 'silent') console.warn(...args); }

function auth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function hardFallbackRoster({ mode, budgetMin, budgetMax, email }) {
  return {
    mode,
    budget: { min: budgetMin, max: budgetMax },
    email,
    createdAt: new Date().toISOString(),
    rosa: [
      { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
      { ruolo: 'D', nome: 'Terzino Motorino', costo: 18 },
      { ruolo: 'D', nome: 'Centrale Affidabile', costo: 22 },
      { ruolo: 'C', nome: 'Regista Tecnico', costo: 40 },
      { ruolo: 'C', nome: 'Mezzala Inserimenti', costo: 32 },
      { ruolo: 'A', nome: 'Prima Punta Bomber', costo: 120 },
      { ruolo: 'A', nome: 'Esterno Rapido', costo: 50 }
    ],
    note: 'Roster di esempio (fallback). Configura OPENAI_API_KEY per generazione AI.'
  };
}

function parseJsonLenient(txt) {
  if (!txt || typeof txt !== 'string') return null;
  // rimuovi eventuali ```json ... ``` o ``` ... ```
  const stripped = txt.replace(/^```json\s*|^```\s*|```$/gmi, '');
  try { return JSON.parse(stripped); } catch {}
  // tenta a isolare il primo oggetto { ... }
  const i = stripped.indexOf('{');
  const j = stripped.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(stripped.slice(i, j + 1)); } catch {}
  }
  return null;
}

async function generateRosterAI({ mode, budgetMin, budgetMax, email }) {
  // Se non c'è OpenAI -> fallback immediato
  if (!openai) {
    logWarn('OpenAI non configurato: uso fallback statico.');
    return hardFallbackRoster({ mode, budgetMin, budgetMax, email });
  }

  const prompt = `
Sei un consulente fantacalcio. Crea una rosa "${mode}" rispettando il budget ${budgetMin}-${budgetMax}.
Ritorna JSON con campi: mode, budget{min,max}, email, createdAt, rosa[ {ruolo,nome,costo} ], note.
Ruoli: P=portiere, D=difensore, C=centrocampista, A=attaccante. 10-12 giocatori totali.
  `.trim();

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
      // niente response_format per massima compatibilità
    });

    const txt = resp.choices?.[0]?.message?.content || '';
    logDebug('OpenAI content:', txt);

    const parsed = parseJsonLenient(txt) || hardFallbackRoster({ mode, budgetMin, budgetMax, email });
    parsed.mode ??= mode;
    parsed.budget ??= { min: budgetMin, max: budgetMax };
    parsed.email ??= email;
    parsed.createdAt ??= new Date().toISOString();
    if (!Array.isArray(parsed.rosa)) parsed.rosa = [];
    return parsed;
  } catch (err) {
    logWarn('Generazione AI fallita, uso fallback. Dettagli:', err?.message || err);
    return hardFallbackRoster({ mode, budgetMin, budgetMax, email });
  }
}

function buildPdf(res, roster) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FantaElite_${roster.mode}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.on('error', (e) => {
    // se PDFKit fallisce, chiudiamo la risposta JSON-friendly
    try {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } catch {}
    try {
      res.status(500).end(JSON.stringify({ error: 'PDF error', details: String(e?.message || e) }));
    } catch {}
  });

  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(20).text('FantaElite - Rosa Generata', { align: 'left' });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(12)
     .text(`Modalità: ${roster.mode}`)
     .text(`Budget: ${roster.budget?.min ?? '-'} - ${roster.budget?.max ?? '-'}`)
     .text(`Email: ${roster.email || '-'}`)
     .text(`Creato: ${new Date(roster.createdAt).toLocaleString()}`);
  doc.moveDown();

  doc.font('Helvetica-Bold').fontSize(14).text('Giocatori:');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(12);

  const rosa = roster.rosa || [];
  if (rosa.length === 0) {
    doc.text('Nessun giocatore disponibile.');
  } else {
    rosa.forEach((g, i) => {
      const riga = `${i + 1}. [${g.ruolo}] ${g.nome} — ${g.costo} crediti`;
      doc.text(riga);
    });
  }

  doc.moveDown();
  if (roster.note) {
    doc.font('Helvetica-Oblique').text(`Note: ${roster.note}`);
  }

  doc.end();
}

// ---- Routes ----
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), openaiSeen: !!OPENAI_API_KEY });
});

app.post('/api/test-generate', auth, async (req, res) => {
  try {
    const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};
    const roster = await generateRosterAI({ mode, budgetMin, budgetMax, email });
    res.json(roster);
  } catch (err) {
    log('❌ /api/test-generate error:', err);
    res.status(500).json({ error: 'Errore interno test-generate', details: String(err?.message || err) });
  }
});

app.post('/api/generate', auth, async (req, res) => {
  try {
    const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};
    const roster = await generateRosterAI({ mode, budgetMin, budgetMax, email });
    buildPdf(res, roster);
  } catch (err) {
    log('❌ /api/generate error:', err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).end(JSON.stringify({ error: 'Errore interno durante la generazione', details: String(err?.message || err) }));
  }
});

// Webhook Ko-fi (placeholder)
app.post('/webhook/kofi', express.json(), (req, res) => {
  try {
    const token = req.headers['x-kofi-signature'] || req.query?.verification_token || '';
    if (KOFI_VERIFICATION_TOKEN && token !== KOFI_VERIFICATION_TOKEN) {
      return res.status(401).json({ error: 'Ko-fi token non valido' });
    }
    // TODO: valida evento e avvia generazione PDF + email
    res.json({ ok: true });
  } catch (err) {
    log('❌ /webhook/kofi error:', err);
    res.status(500).json({ error: 'Errore webhook Ko-fi' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  if (!KOFI_VERIFICATION_TOKEN) console.warn('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi.');
  if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY mancante: userò roster di fallback statico.');
});

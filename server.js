// server.js (ESM)
// Avvio consigliato: node --env-file=.env server.js

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ===========================
// Config & Utility
// ===========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT  = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'abc123!fantaElite2025';

const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''; // proj_xxx
const OPENAI_FORCE_PROJECT_HEADER = String(process.env.OPENAI_FORCE_PROJECT_HEADER || 'false').toLowerCase() === 'true';

// Ko-fi
const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';

// Email (Resend) opzionale
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL     = process.env.FROM_EMAIL     || 'FantaElite <no-reply@fantaelite.app>';

// Cartella temporanea per PDF
const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ===========================
// Log di avvio chiari
// ===========================
function logStartup() {
  console.log(`\n✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  console.log('🔧 Config:');
  console.log(`   - PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`   - API_KEY presente: ${API_KEY ? 'sì' : 'NO'}`);
  console.log(`   - KOFI_VERIFICATION_TOKEN: ${KOFI_VERIFICATION_TOKEN ? 'sì' : 'NO'}`);

  const hasOpenAI = !!OPENAI_API_KEY;
  const keyType = hasOpenAI
    ? (OPENAI_API_KEY.startsWith('sk-proj-') ? 'Project Key (sk-proj-)' : 'User Key (sk-)')
    : 'assenza chiave';
  console.log(`   - OPENAI_API_KEY: ${hasOpenAI ? 'sì' : 'NO'} (${keyType})`);
  console.log(`   - OPENAI_MODEL: ${OPENAI_MODEL}`);
  console.log(
    `   - OPENAI_PROJECT: ${OPENAI_PROJECT ? OPENAI_PROJECT : '—'}`
  );
  console.log(
    `   - Header OpenAI-Project: ${
      !hasOpenAI ? 'n/a'
      : (OPENAI_FORCE_PROJECT_HEADER
          ? `FORZATO (project=${OPENAI_PROJECT || 'manca'})`
          : (OPENAI_API_KEY.startsWith('sk-proj-')
              ? 'NO (chiave sk-proj- non lo richiede, a meno di forzatura)'
              : (OPENAI_PROJECT ? `sì (${OPENAI_PROJECT})` : 'NO (manca OPENAI_PROJECT)')))
    }`
  );

  if (!hasOpenAI) {
    console.warn('⚠️  OPENAI_API_KEY mancante: userò roster di fallback statico.');
  }
  if (!KOFI_VERIFICATION_TOKEN) {
    console.warn('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi.');
  }
  if (RESEND_API_KEY && !FROM_EMAIL) {
    console.warn('⚠️  Hai RESEND_API_KEY ma non FROM_EMAIL: niente invio email.');
  }
}

// ===========================
// OpenAI helper
// ===========================
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY assente');
  }

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // Regola: di default aggiungiamo OpenAI-Project SOLO con chiavi "sk-" e se OPENAI_PROJECT è valorizzato.
  // Se l'utente imposta OPENAI_FORCE_PROJECT_HEADER=true, aggiungiamo SEMPRE l'header (anche con sk-proj-).
  if ((OPENAI_PROJECT && !OPENAI_API_KEY.startsWith('sk-proj-')) || OPENAI_FORCE_PROJECT_HEADER) {
    headers['OpenAI-Project'] = OPENAI_PROJECT || '';
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

// ===========================
// Generazione rosa
// ===========================
function buildRosaFallback(mode, budgetMin, budgetMax) {
  const rosa = [
    { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino', costo: 18 },
    { ruolo: 'D', nome: 'Centrale Affidabile', costo: 22 },
    { ruolo: 'C', nome: 'Regista Tecnico', costo: 40 },
    { ruolo: 'C', nome: 'Mezzala Inserimenti', costo: 32 },
    { ruolo: 'A', nome: 'Prima Punta Bomber', costo: 120 },
    { ruolo: 'A', nome: 'Esterno Rapido', costo: 50 },
  ];
  const totale = rosa.reduce((s, x) => s + (x.costo || 0), 0);
  return { mode, budget: { min: budgetMin, max: budgetMax }, totale, rosa, note: 'Roster di esempio (fallback).' };
}

async function buildRosaAI(mode, budgetMin, budgetMax) {
  const sys = {
    role: 'system',
    content:
      'Sei un assistente che crea una rosa per il fantacalcio. Rispondi SOLO in JSON valido, ' +
      'con una lista "rosa" di oggetti {ruolo, nome, costo} e un "totale".'
  };
  const usr = {
    role: 'user',
    content:
      `Genera una rosa "${mode}" con budget tra ${budgetMin} e ${budgetMax}. ` +
      'Restituisci JSON: { "rosa": [{ "ruolo":"P|D|C|A", "nome":"...", "costo":number }, ...], "totale": number }. ' +
      'Niente testo fuori dal JSON.'
  };

  const raw = await callOpenAI([sys, usr]);

  let jsonText = raw.trim();
  const firstBrace = jsonText.indexOf('{');
  const lastBrace  = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Impossibile parse JSON da OpenAI. Risposta: ${raw}`);
  }

  if (!Array.isArray(data.rosa)) {
    throw new Error('JSON AI senza "rosa" valida');
  }

  const totale = data.totale ?? data.rosa.reduce((s, x) => s + (x.costo || 0), 0);
  return {
    mode,
    budget: { min: budgetMin, max: budgetMax },
    totale,
    rosa: data.rosa
  };
}

// ===========================
// PDF helper
// ===========================
function pdfBufferFromRosa(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { mode, budget, totale, rosa, email, createdAt } = payload;

    doc.fontSize(20).text('FantaElite - Rosa generata', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Modalità: ${mode}`);
    doc.text(`Budget: ${budget?.min ?? '-'} - ${budget?.max ?? '-'}`);
    if (typeof totale === 'number') doc.text(`Totale stimato: ${totale}`);
    if (email) doc.text(`Email: ${email}`);
    if (createdAt) doc.text(`Creato: ${new Date(createdAt).toLocaleString()}`);
    doc.moveDown();

    doc.fontSize(14).text('Giocatori:', { underline: true });
    doc.moveDown(0.5);

    if (Array.isArray(rosa)) {
      rosa.forEach((p, i) => {
        doc.fontSize(12).text(
          `${i + 1}. [${p.ruolo?.toUpperCase?.() || '?'}] ${p.nome || 'Giocatore'} - ${p.costo ?? '?'} crediti`
        );
      });
    } else {
      doc.text('Nessun giocatore trovato.');
    }

    doc.end();
  });
}

// ===========================
// Email (via Resend) opzionale
// ===========================
async function sendEmailWithResend(to, subject, html, attachments = []) {
  if (!RESEND_API_KEY) return { ok: false, skip: 'RESEND_API_KEY mancante' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
      attachments
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

// ===========================
// Express app & middleware
// ===========================
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice('Bearer '.length) : '';
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===========================
// Endpoints
// ===========================
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Debug OpenAI
app.get('/debug/openai', async (req, res) => {
  try {
    const content = await callOpenAI([
      { role: 'system', content: 'Sei un ping di test. Rispondi con {"pong":true} solo JSON.' },
      { role: 'user', content: 'Ping' }
    ]);

    let body = content.trim();
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a !== -1 && b !== -1) body = body.slice(a, b + 1);
    let json;
    try { json = JSON.parse(body); } catch { json = { raw: content }; }

    res.json({
      ok: true,
      model: OPENAI_MODEL,
      keyType: OPENAI_API_KEY.startsWith('sk-proj-') ? 'sk-proj' : 'sk',
      project: OPENAI_PROJECT || null,
      forcedHeader: OPENAI_FORCE_PROJECT_HEADER,
      reply: json
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Generazione JSON
app.post('/api/test-generate', auth, async (req, res) => {
  const { mode = 'equilibrata', email, budgetMin = 380, budgetMax = 520 } = req.body || {};
  const base = { mode, budget: { min: budgetMin, max: budgetMax }, email, createdAt: new Date().toISOString() };

  try {
    let result;
    if (OPENAI_API_KEY) {
      result = await buildRosaAI(mode, budgetMin, budgetMax);
    } else {
      result = buildRosaFallback(mode, budgetMin, budgetMax);
      result.note = (result.note || '') + ' Configura OPENAI_API_KEY/PROJECT per generazione AI.';
    }
    res.json({ ...base, ...result });
  } catch (err) {
    const fb = buildRosaFallback(mode, budgetMin, budgetMax);
    res.json({ ...base, ...fb, note: 'Errore AI, inviato roster di fallback.', error: String(err) });
  }
});

// Generazione PDF
app.post('/api/generate', auth, async (req, res) => {
  const { mode = 'equilibrata', email, budgetMin = 380, budgetMax = 520 } = req.body || {};
  const base = { mode, budget: { min: budgetMin, max: budgetMax }, email, createdAt: new Date().toISOString() };

  try {
    let data;
    if (OPENAI_API_KEY) {
      data = await buildRosaAI(mode, budgetMin, budgetMax);
    } else {
      data = buildRosaFallback(mode, budgetMin, budgetMax);
      data.note = (data.note || '') + ' Configura OPENAI_API_KEY/PROJECT per generazione AI.';
    }

    const payload = { ...base, ...data };
    const buf = await pdfBufferFromRosa(payload);

    const filename = `FantaElite_${mode}_${uuidv4().slice(0,8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buf);
  } catch (err) {
    console.error('Errore PDF:', err);
    return res.status(500).send('Errore interno durante la generazione');
  }
});

// Webhook Ko-fi
app.post('/webhooks/kofi', async (req, res) => {
  try {
    const body = req.body || {};
    if (!KOFI_VERIFICATION_TOKEN || body.verification_token !== KOFI_VERIFICATION_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Token Ko-fi non valido' });
    }

    const mode = (body?.mode || 'equilibrata').toLowerCase();
    const email = body?.email || body?.payer_email || body?.kofi_email;
    const budgetMin = Number(body?.budgetMin ?? 380);
    const budgetMax = Number(body?.budgetMax ?? 520);

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email mancante nel payload Ko-fi' });
    }

    let data;
    try {
      data = OPENAI_API_KEY
        ? await buildRosaAI(mode, budgetMin, budgetMax)
        : buildRosaFallback(mode, budgetMin, budgetMax);
    } catch (e) {
      data = buildRosaFallback(mode, budgetMin, budgetMax);
      data.note = 'AI errore, inviato fallback.';
    }

    const payload = { mode, email, budget: { min: budgetMin, max: budgetMax }, createdAt: new Date().toISOString(), ...data };
    const pdfBuffer = await pdfBufferFromRosa(payload);

    if (RESEND_API_KEY) {
      const base64 = pdfBuffer.toString('base64');
      const resp = await sendEmailWithResend(
        email,
        'La tua rosa FantaElite',
        `<p>Ciao! In allegato la tua rosa <b>${mode}</b>.</p><p>Grazie per l’acquisto!</p>`,
        [{ filename: `FantaElite_${mode}.pdf`, content: base64 }]
      );
      return res.json({ ok: true, email: resp, message: 'Email inviata (se tutto ok).' });
    } else {
      const fileId = uuidv4();
      const filePath = path.join(OUT_DIR, `kofi_${fileId}.pdf`);
      fs.writeFileSync(filePath, pdfBuffer);
      const url = `${PUBLIC_URL}/download/${path.basename(filePath)}`;
      return res.json({ ok: true, download: url });
    }
  } catch (err) {
    console.error('Webhook Ko-fi errore:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Download statici
app.get('/download/:file', (req, res) => {
  const file = req.params.file;
  const filePath = path.join(OUT_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File non trovato');
  res.setHeader('Content-Type', 'application/pdf');
  res.download(filePath);
});

// ===========================
// Start
// ===========================
const appInstance = app.listen(PORT, () => {
  logStartup();
});

// Gestione porta occupata
appInstance.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Porta ${PORT} occupata. Arresta il processo che la usa oppure cambia PORT.`);
  } else {
    console.error('❌ Errore server:', err);
  }
});

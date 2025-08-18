// server.js (ESM) — FantaElite Backend all-in-one
// Avvia con:  node --env-file=.env server.js

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';

// (opzionale) carica .env anche senza --env-file
try {
  const { config } = await import('dotenv');
  config();
} catch { /* ok se non c'è dotenv */ }

// -----------------------
// Configurazione da env
// -----------------------
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'changeme';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_PROJECT = (process.env.OPENAI_PROJECT || '').trim();
const OPENAI_FORCE_PROJECT_HEADER = String(process.env.OPENAI_FORCE_PROJECT_HEADER || '')
  .toLowerCase() === 'true';

const KOFI_VERIFICATION_TOKEN = (process.env.KOFI_VERIFICATION_TOKEN || '').trim();

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const FROM_EMAIL = process.env.FROM_EMAIL || ''; // es: "FantaElite <noreply@tuodominio.it>"

// -----------------------
// App & Middleware
// -----------------------
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true })); // per Ko-fi (application/x-www-form-urlencoded)

// Storage in memoria per download temporanei PDF
const DOWNLOADS = new Map(); // id -> { buffer, filename, createdAt }

// -----------------------
// Util: log avvio
// -----------------------
function logStartup() {
  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  console.log(`🔧 Config:`);
  console.log(`   - PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`   - API_KEY presente: ${API_KEY ? 'sì' : 'no'}`);
  console.log(`   - KOFI_VERIFICATION_TOKEN: ${KOFI_VERIFICATION_TOKEN ? 'sì' : 'no'}`);
  console.log(`   - OPENAI_API_KEY: ${OPENAI_API_KEY ? (OPENAI_API_KEY.startsWith('sk-proj-') ? 'sì (Project Key (sk-proj-))' : 'sì (Account Key)') : 'no'}`);
  console.log(`   - OPENAI_MODEL: ${OPENAI_MODEL}`);
  console.log(`   - OPENAI_PROJECT: ${OPENAI_PROJECT || '—'}`);
  console.log(`   - Header OpenAI-Project: ${OPENAI_FORCE_PROJECT_HEADER ? `FORZATO (project=${OPENAI_PROJECT || '—'})` : (OPENAI_PROJECT ? 'AUTO (se key è sk-proj-)' : 'no')}`);
  if (RESEND_API_KEY) {
    console.log(`   - RESEND: attivo (${FROM_EMAIL || 'mittente non impostato'})`);
  } else {
    console.log(`   - RESEND: non attivo`);
  }
}

// -----------------------
// OpenAI (fetch diretto)
// -----------------------
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY assente');
  }

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // Se uso chiave di progetto (sk-proj-...), serve header OpenAI-Project = proj_...
  if ((OPENAI_PROJECT && OPENAI_API_KEY.startsWith('sk-proj-')) &&
      (OPENAI_FORCE_PROJECT_HEADER || true)) {
    headers['OpenAI-Project'] = OPENAI_PROJECT;
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

// -----------------------
// Generazione rosa (AI o fallback)
// -----------------------
function fallbackRoster(mode, budgetMin, budgetMax) {
  return [
    { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino', costo: 18 },
    { ruolo: 'D', nome: 'Centrale Affidabile', costo: 22 },
    { ruolo: 'C', nome: 'Regista Tecnico', costo: 40 },
    { ruolo: 'C', nome: 'Mezzala Inserimenti', costo: 32 },
    { ruolo: 'A', nome: 'Prima Punta Bomber', costo: 120 },
    { ruolo: 'A', nome: 'Esterno Rapido', costo: 50 },
  ];
}

async function generateRoster({ mode, budgetMin, budgetMax, email }) {
  if (!OPENAI_API_KEY) {
    const rosa = fallbackRoster(mode, budgetMin, budgetMax);
    const totale = rosa.reduce((s, r) => s + (r.costo || 0), 0);
    return {
      mode, budget: { min: budgetMin, max: budgetMax }, totale, rosa,
      note: 'Roster di esempio (fallback). Configura OPENAI_API_KEY/PROJECT per generazione AI.',
      email, createdAt: new Date().toISOString()
    };
  }

  const prompt = `
Sei un consulente FantaElite. Genera una rosa coerente con:
- Modalità: ${mode}
- Budget: ${budgetMin}-${budgetMax}

Rispondi SOLO in JSON con array "rosa" di oggetti {ruolo, nome, costo} e un campo "note".
`;
  const content = await callOpenAI([
    { role: 'system', content: 'Sei un assistente che risponde SOLO in JSON valido.' },
    { role: 'user', content: prompt }
  ]);

  // Prova a fare il parse del JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // fallback se l'AI ha risposto male
    const rosa = fallbackRoster(mode, budgetMin, budgetMax);
    const totale = rosa.reduce((s, r) => s + (r.costo || 0), 0);
    return {
      mode, budget: { min: budgetMin, max: budgetMax }, totale, rosa,
      note: 'AI non ha restituito JSON valido: uso fallback.',
      email, createdAt: new Date().toISOString()
    };
  }

  const rosa = Array.isArray(parsed.rosa) ? parsed.rosa : fallbackRoster(mode, budgetMin, budgetMax);
  const totale = rosa.reduce((s, r) => s + (r.costo || 0), 0);
  const note = parsed.note || 'Rosa generata via AI.';
  return {
    mode, budget: { min: budgetMin, max: budgetMax }, totale, rosa,
    note, email, createdAt: new Date().toISOString()
  };
}

// -----------------------
// PDF helper
// -----------------------
function makePDFBuffer(rosa, meta = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Titolo
    doc.fontSize(20).text('FantaElite — Rosa Generata', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Modalità: ${meta.mode || ''}`);
    doc.text(`Budget: ${meta.budget?.min ?? ''} - ${meta.budget?.max ?? ''}`);
    doc.text(`Generata: ${meta.createdAt || new Date().toISOString()}`);
    if (meta.email) doc.text(`Email: ${meta.email}`);
    doc.moveDown();

    // Tabella semplice
    doc.fontSize(12).text('Rosa:', { underline: true });
    doc.moveDown(0.5);

    rosa.forEach((r, i) => {
      doc.text(`${i + 1}. [${r.ruolo}] ${r.nome} — ${r.costo}`);
    });

    doc.moveDown();
    if (meta.totale != null) {
      doc.fontSize(12).text(`Totale: ${meta.totale}`);
    }
    if (meta.note) {
      doc.moveDown();
      doc.fontSize(10).text(`Note: ${meta.note}`);
    }

    doc.end();
  });
}

// -----------------------
// Utils Ko-fi
// -----------------------
function parsePrefsFromMessage(message = '') {
  // es: "mode=equilibrata; budgetMin=380; budgetMax=520; email=a@b.it"
  const out = {};
  message.split(';').forEach(part => {
    const [kRaw, vRaw] = part.split('=');
    if (!kRaw || !vRaw) return;
    const k = kRaw.trim();
    const v = vRaw.trim();
    out[k] = v;
  });
  const mode = (out.mode || 'equilibrata').toLowerCase();
  const budgetMin = Number(out.budgetMin || 380);
  const budgetMax = Number(out.budgetMax || 520);
  const email = out.email || '';
  return { mode, budgetMin, budgetMax, email };
}

// -----------------------
// Endpoint: Health
// -----------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// -----------------------
// Endpoint: Debug OpenAI
// -----------------------
app.get('/debug/openai', async (req, res) => {
  try {
    const content = await callOpenAI([
      { role: 'user', content: 'Di\' solo "ok"' }
    ]);
    res.json({
      ok: true,
      model: OPENAI_MODEL,
      keyPrefix: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 8) : null,
      reply: String(content).slice(0, 200)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// -----------------------
// Endpoint: Debug Ko-fi echo
// (mostra cosa vede il server: header/body token)
// -----------------------
app.post('/debug/kofi-echo', (req, res) => {
  const envTok = (process.env.KOFI_VERIFICATION_TOKEN || '').trim();
  const hdrTok = (req.get('X-Verification-Token') || '').trim();

  let raw = req.body?.data;
  let bodyTok = '';
  try {
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      bodyTok = (parsed?.verification_token || '').trim();
    }
  } catch {}

  res.json({
    envTokenEndsWith: envTok ? envTok.slice(-6) : null,
    headerTokenEndsWith: hdrTok ? hdrTok.slice(-6) : null,
    bodyTokenEndsWith: bodyTok ? bodyTok.slice(-6) : null,
    sameHeaderVsEnv: envTok && hdrTok ? (envTok === hdrTok) : null,
    sameBodyVsEnv: envTok && bodyTok ? (envTok === bodyTok) : null,
    receivedHeaders: req.headers,
    receivedBody: req.body
  });
});

// -----------------------
// Endpoint: JSON (protetto da API key)
// -----------------------
app.post('/api/test-generate', async (req, res) => {
  try {
    const auth = req.get('Authorization') || '';
    if (auth !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};
    const result = await generateRoster({ mode, budgetMin, budgetMax, email });
    return res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// -----------------------
// Endpoint: PDF (protetto da API key)
// -----------------------
app.post('/api/generate', async (req, res) => {
  try {
    const auth = req.get('Authorization') || '';
    if (auth !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};
    const data = await generateRoster({ mode, budgetMin, budgetMax, email });
    const pdf = await makePDFBuffer(data.rosa, data);

    const filename = `FantaElite_${mode}_${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Errore interno durante la generazione', detail: String(err) });
  }
});

// -----------------------
// Endpoint: Download temporanei
// -----------------------
app.get('/download/:id', (req, res) => {
  const rec = DOWNLOADS.get(req.params.id);
  if (!rec) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${rec.filename}"`);
  res.send(rec.buffer);
});

// -----------------------
// Webhook Ko-fi (tollerante: header O body)
// -----------------------
app.post('/webhook/kofi', async (req, res) => {
  try {
    const ENV_TOKEN = (process.env.KOFI_VERIFICATION_TOKEN || '').trim();

    // 1) token da header
    let receivedToken = (req.get('X-Verification-Token') || '').trim();

    // 2) se mancante, prova dal body (data=... JSON Ko-fi)
    if (!receivedToken) {
      const raw = req.body?.data;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.verification_token) {
            receivedToken = String(parsed.verification_token).trim();
          }
        } catch {}
      }
    }

    if (ENV_TOKEN && receivedToken !== ENV_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Token verifica Ko-fi non valido' });
    }

    // Parse payload Ko-fi
    const raw = req.body?.data;
    if (typeof raw !== 'string') {
      return res.status(400).json({ ok: false, error: 'Payload Ko-fi non valido (manca data)' });
    }
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, error: 'data non è JSON' }); }

    const message = data?.message || '';
    const { mode, budgetMin, budgetMax, email } = parsePrefsFromMessage(message);

    // Genera rosa e PDF
    const result = await generateRoster({ mode, budgetMin, budgetMax, email });
    const pdf = await makePDFBuffer(result.rosa, result);

    // Salva per download temporaneo
    const id = uuidv4();
    const filename = `FantaElite_${mode}_${new Date().toISOString().slice(0,10)}.pdf`;
    DOWNLOADS.set(id, { buffer: pdf, filename, createdAt: Date.now() });

    const link = `${PUBLIC_URL}/download/${id}`;

    // (Facoltativo) invio email via Resend
    if (RESEND_API_KEY && FROM_EMAIL && email) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: email,
            subject: 'La tua rosa FantaElite',
            html: `<p>Ciao! Ecco la tua rosa <b>${mode}</b>.<br>
                   Scarica il PDF qui: <a href="${link}">${link}</a></p>`
          })
        });
      } catch (e) {
        console.warn('⚠️  Invio email fallito:', e?.message || e);
      }
    }

    res.json({ ok: true, mode, budgetMin, budgetMax, email, download: link });
  } catch (err) {
    console.error('Errore webhook Ko-fi:', err);
    res.status(500).json({ ok: false, error: 'Errore interno' });
  }
});

// -----------------------
// Avvio server
// -----------------------
app.listen(PORT, () => {
  logStartup();
});

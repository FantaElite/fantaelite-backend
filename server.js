// server.js
// Avvio: node --env-file=.env server.js
// Dipendenze: npm i express cors pdfkit uuid

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --------------------------------------------------------------------------------------
// Setup base (ESM __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------------------------------------
// Config da ENV
const PORT        = process.env.PORT || 3000;
const PUBLIC_URL  = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY     = process.env.API_KEY || '';                // per proteggere /api/*
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';         // chiave sk-proj-...
const OPENAI_MODEL= process.env.OPENAI_MODEL || 'gpt-4o-mini';
const KOFI_TOKEN  = process.env.KOFI_VERIFICATION_TOKEN || ''; // opzionale (webhook Ko-fi)

// --------------------------------------------------------------------------------------
// App
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --------------------------------------------------------------------------------------
// Log d'avvio CHIARI
(function startupLog() {
  const keyPrefix = OPENAI_KEY ? OPENAI_KEY.slice(0, 7) : 'assente';
  const isProjectKey = OPENAI_KEY.startsWith('sk-proj-');

  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  console.log('🔧 Config:');
  console.log(`   - PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`   - API_KEY presente: ${API_KEY ? 'sì' : 'no'}`);
  console.log(`   - KOFI_VERIFICATION_TOKEN: ${KOFI_TOKEN ? 'sì' : 'no'}`);
  console.log(`   - OPENAI_API_KEY: ${OPENAI_KEY ? (isProjectKey ? 'sì (Project Key sk-proj-)' : 'sì') : 'no'}`);
  console.log(`   - OPENAI_MODEL: ${OPENAI_MODEL}`);
  console.log('   - Header OpenAI-Project: NON utilizzato (non necessario con le key attuali)');
})();

// --------------------------------------------------------------------------------------
// Util: guardia API key Bearer
function requireApiKey(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!API_KEY || token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized (API key errata o assente)' });
  }
  next();
}

// --------------------------------------------------------------------------------------
// OpenAI (senza header di progetto)
async function callOpenAI(messages) {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY assente');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
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
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// --------------------------------------------------------------------------------------
// Generazione rosa AI (parsing robusto di JSON in risposta)
async function generaRosaAI({ mode = 'equilibrata', budgetMin = 380, budgetMax = 520 }) {
  const sys = {
    role: 'system',
    content: 'Sei un assistente che crea la rosa per FantaElite in formato JSON puro.'
  };
  const usr = {
    role: 'user',
    content:
`Genera una rosa per fantacalcio modalità "${mode}" con budget tra ${budgetMin} e ${budgetMax}.
Restituisci SOLO JSON compatibile, senza testo extra, del tipo:
{
  "rosa": [
    {"ruolo":"P","nome":"...","costo":..},
    {"ruolo":"D","nome":"...","costo":..}
  ]
}`
  };

  const raw = await callOpenAI([sys, usr]);

  // Elimina eventuali fence ```json
  const cleaned = raw
    .replace(/```json/gi, '```')
    .replace(/```/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Prova estrazione JSON grezza
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('Risposta OpenAI non in JSON parsabile');
    }
  }

  const rosa = Array.isArray(parsed.rosa) ? parsed.rosa : [];
  if (!rosa.length) throw new Error('JSON valido ma lista "rosa" vuota');

  return rosa.map((r) => ({
    ruolo: String(r.ruolo || '').toUpperCase().slice(0, 1) || 'C',
    nome : String(r.nome || 'Giocatore'),
    costo: Number(r.costo || 1)
  }));
}

// Fallback statico se OpenAI non è disponibile
function generaRosaFallback() {
  return [
    { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino',     costo: 18 },
    { ruolo: 'D', nome: 'Centrale Affidabile',  costo: 22 },
    { ruolo: 'C', nome: 'Regista Tecnico',      costo: 40 },
    { ruolo: 'C', nome: 'Mezzala Inserimenti',  costo: 32 },
    { ruolo: 'A', nome: 'Prima Punta Bomber',   costo: 120 },
    { ruolo: 'A', nome: 'Esterno Rapido',       costo: 50 },
  ];
}

// --------------------------------------------------------------------------------------
// PDF helper
function buildPdfBuffer({ mode, budget, rosa }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Titolo
    doc.fontSize(20).text(`Rosa FantaElite (${mode})`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generata: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    // Budget
    doc.fontSize(12).text(`Budget: ${budget.min} - ${budget.max}`);
    doc.moveDown(0.5);

    // Tabella semplice
    doc.fontSize(12).text('Giocatori:', { underline: true });
    doc.moveDown(0.5);

    let totale = 0;
    rosa.forEach((r, i) => {
      totale += Number(r.costo || 0);
      doc.text(
        `${String(i + 1).padStart(2, '0')}. [${r.ruolo}] ${r.nome} - ${r.costo} crediti`
      );
    });

    doc.moveDown(1);
    doc.fontSize(14).text(`Totale: ${totale} crediti`, { align: 'right', underline: true });

    doc.end();
  });
}

// --------------------------------------------------------------------------------------
// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Debug OpenAI: chiama il modello e dice "ok"
app.get('/debug/openai', async (req, res) => {
  try {
    if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY assente');

    const reply = await callOpenAI([
      { role: 'system', content: 'Rispondi solo con la parola: ok' },
      { role: 'user',   content: 'Test' }
    ]);

    return res.json({
      ok: true,
      model: OPENAI_MODEL,
      keyPrefix: OPENAI_KEY.slice(0, 10),
      reply
    });
  } catch (err) {
    return res.status(500).send(JSON.stringify({ ok: false, error: String(err) }));
  }
});

// --------------------------------------------------------------------------------------
// API protette (Bearer API_KEY)

// JSON (test rapido, senza PDF)
app.post('/api/test-generate', requireApiKey, async (req, res) => {
  const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};

  let rosa, note;
  try {
    rosa = await generaRosaAI({ mode, budgetMin, budgetMax });
    note = 'Roster generato con OpenAI.';
  } catch (e) {
    rosa = generaRosaFallback();
    note = 'Roster di esempio (fallback). Configura correttamente OPENAI_API_KEY.';
  }

  const totale = rosa.reduce((s, r) => s + Number(r.costo || 0), 0);

  res.json({
    mode,
    budget: { min: budgetMin, max: budgetMax },
    totale,
    rosa,
    note,
    email,
    createdAt: new Date().toISOString()
  });
});

// PDF (download)
app.post('/api/generate', requireApiKey, async (req, res) => {
  const { mode = 'equilibrata', email = '', budgetMin = 380, budgetMax = 520 } = req.body || {};

  let rosa, note;
  try {
    rosa = await generaRosaAI({ mode, budgetMin, budgetMax });
    note = 'Roster generato con OpenAI.';
  } catch (e) {
    rosa = generaRosaFallback();
    note = 'Roster di esempio (fallback). Configura correttamente OPENAI_API_KEY.';
  }

  const buf = await buildPdfBuffer({
    mode,
    budget: { min: budgetMin, max: budgetMax },
    rosa
  });

  const filename = `FantaElite_${mode}_${new Date().toISOString().slice(0,10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Note', note);
  res.send(buf);
});

// --------------------------------------------------------------------------------------
// (Opzionale) Webhook Ko-fi super-minimale (solo verifica token e log)
// Configura su Ko-fi il Verification Token uguale a KOFI_VERIFICATION_TOKEN
app.post('/webhook/kofi', async (req, res) => {
  try {
    if (!KOFI_TOKEN) return res.status(501).json({ ok: false, error: 'KOFI_VERIFICATION_TOKEN non configurato' });
    const body = req.body || {};
    if (body.verification_token !== KOFI_TOKEN) {
      return res.status(403).json({ ok: false, error: 'Token verifica Ko-fi non valido' });
    }

    // TODO: leggi dati pagamento, chiama generazione PDF e invia email/link.
    console.log('🔔 Webhook Ko-fi OK:', JSON.stringify(body, null, 2));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// --------------------------------------------------------------------------------------
// Statico (se vuoi esporre una pagina test semplice)
app.get('/', (req, res) => {
  res.type('text/plain').send('FantaElite backend attivo. Prova /health o /debug/openai.');
});

// --------------------------------------------------------------------------------------
// Start server
app.listen(PORT, () => {
  // Già loggato sopra
});

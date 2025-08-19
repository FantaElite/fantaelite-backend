// server.js
// Avvio rapido FantaElite – versione "fast ship" con endpoint pubblico protetto da form secret
// - /api/generate            (autenticato con API_KEY) -> PDF
// - /api/generate-public     (protetto da PUBLIC_FORM_SECRET) -> PDF
// - /api/test-generate       (JSON, per test rapidi)
// - /debug/openai, /health   (diagnostica)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';

// ---------- Config ----------
const app  = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY    = process.env.API_KEY || ''; // per /api/generate
const FORM_SECRET = process.env.PUBLIC_FORM_SECRET || ''; // per /api/generate-public

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT; // opzionale con sk-proj-...

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*'}));

// ---------- Log di avvio ----------
function yesNo(v){ return v ? 'sì' : 'no'; }
console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
console.log('🔧 Config:');
console.log(`   - PUBLIC_URL: ${PUBLIC_URL}`);
console.log(`   - API_KEY presente: ${yesNo(!!API_KEY)}`);
console.log(`   - OPENAI_API_KEY: ${yesNo(!!OPENAI_API_KEY)} ${OPENAI_API_KEY?.startsWith('sk-proj-') ? '(Project Key)' : ''}`);
console.log(`   - OPENAI_MODEL: ${OPENAI_MODEL}`);
console.log(`   - OPENAI_PROJECT: ${OPENAI_PROJECT || '(nessuno)'}`);
console.log(`   - PUBLIC_FORM_SECRET: ${FORM_SECRET ? '(impostato)' : '(mancante!)'}`);

// ---------- Utilità ----------
function parsePrefs(body) {
  const mode = (body.mode || 'equilibrata').toLowerCase();
  const email = body.email || '';
  const budgetMin = Number(body.budgetMin ?? 380);
  const budgetMax = Number(body.budgetMax ?? 520);
  return { mode, email, budgetMin, budgetMax };
}

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY assente');

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (OPENAI_PROJECT) {
    headers['OpenAI-Project'] = OPENAI_PROJECT; // richiesto per sk-proj- se il progetto non è default
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

function parseAITable(text) {
  // Qui potresti fare un parser più sofisticato.
  // Per “fast ship” usiamo un fallback se il testo non è strutturato come ci aspettiamo.
  const roster = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const ln of lines) {
    // formato atteso: "P; Nome; 20" oppure "P | Nome | 20"
    const parts = ln.split(/[;|]/).map(s => s.trim());
    if (parts.length >= 3) {
      const ruolo = parts[0]?.toUpperCase().slice(0,1);
      const nome  = parts[1] || 'Giocatore';
      const costo = parseInt(parts[2], 10) || 10;
      if (['P','D','C','A'].includes(ruolo)) {
        roster.push({ ruolo, nome, costo });
      }
    }
  }
  return roster;
}

function fallbackRoster() {
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

async function generateRoster({ mode, budgetMin, budgetMax }) {
  if (!OPENAI_API_KEY) {
    return { roster: fallbackRoster(), note: 'Roster di esempio (fallback). Configura OPENAI_API_KEY per generazione AI.' };
  }

  const prompt = `Sei un assistente esperto di fantacalcio. Genera una rosa breve e indicativa (7-10 nomi)
per una strategia "${mode}" con budget complessivo tra ${budgetMin} e ${budgetMax}.
Formato UNA riga per giocatore, separando con punto e virgola: RUOLO (P/D/C/A); Nome Giocatore; Costo.
Niente testo aggiuntivo. Solo le righe giocatore.`;

  const ai = await callOpenAI([
    { role: 'system', content: 'Sei un assistente conciso.' },
    { role: 'user', content: prompt }
  ]);

  let roster = parseAITable(ai);
  if (!roster.length) roster = fallbackRoster();

  return { roster, note: 'Roster generato con AI (o fallback se parsing non ottimale).' };
}

function generatePdfBuffer({ mode, budgetMin, budgetMax, roster }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('FantaElite – Rosa Consigliata', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Strategia: ${mode}`);
    doc.text(`Budget: ${budgetMin} – ${budgetMax}`);
    doc.moveDown();

    const tot = roster.reduce((s, r) => s + (r.costo || 0), 0);
    doc.text(`Totale stimato: ${tot}`);
    doc.moveDown();

    const groups = { P: [], D: [], C: [], A: [] };
    roster.forEach(r => { groups[r.ruolo]?.push(r); });

    for (const ruolo of ['P','D','C','A']) {
      if (!groups[ruolo].length) continue;
      const titolo = ruolo === 'P' ? 'Portieri' : ruolo === 'D' ? 'Difensori' : ruolo === 'C' ? 'Centrocampisti' : 'Attaccanti';
      doc.fontSize(14).text(titolo);
      doc.moveDown(0.2);
      groups[ruolo].forEach(r => {
        doc.fontSize(12).text(`- ${r.nome} (${r.costo})`);
      });
      doc.moveDown();
    }

    doc.moveDown();
    doc.fontSize(10).fillColor('#888').text(`Generato da FantaElite • ${new Date().toLocaleString()}`, { align: 'center' });
    doc.end();
  });
}

// ---------- Endpoints ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), now: new Date().toISOString() });
});

app.get('/debug/openai', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.json({ ok: false, error: 'OPENAI_API_KEY assente' });
    const txt = await callOpenAI([
      { role: 'user', content: 'Rispondi solo con: ok' }
    ]);
    res.json({ ok: true, model: OPENAI_MODEL, keyPrefix: OPENAI_API_KEY.slice(0,10), reply: (txt||'').trim().slice(0,20) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// JSON “di prova” per vedere cosa torna (senza PDF)
app.post('/api/test-generate', async (req, res) => {
  try {
    const { mode, email, budgetMin, budgetMax } = parsePrefs(req.body || {});
    const { roster, note } = await generateRoster({ mode, budgetMin, budgetMax });
    const totale = roster.reduce((s, r) => s + (r.costo || 0), 0);
    res.json({
      mode, budget: { min: budgetMin, max: budgetMax }, totale,
      rosa: roster, note, email, createdAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: 'Errore interno durante la generazione', detail: String(e) });
  }
});

// Endpoint AUTH (header Authorization: Bearer API_KEY) -> PDF
app.post('/api/generate', async (req, res) => {
  try {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!API_KEY || token !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { mode, email, budgetMin, budgetMax } = parsePrefs(req.body || {});
    const { roster } = await generateRoster({ mode, budgetMin, budgetMax });
    const pdf = await generatePdfBuffer({ mode, budgetMin, budgetMax, roster });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename=FantaElite_${mode}.pdf`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Errore interno durante la generazione', detail: String(e) });
  }
});

// Endpoint PUBBLICO (protetto da PUBLIC_FORM_SECRET) -> PDF
app.post('/api/generate-public', async (req, res) => {
  try {
    if (!FORM_SECRET) return res.status(500).json({ error: 'PUBLIC_FORM_SECRET non configurato' });
    const formSecret = (req.body?.formSecret || '').trim();
    if (formSecret !== FORM_SECRET) {
      return res.status(401).json({ error: 'formSecret non valido' });
    }

    const { mode, email, budgetMin, budgetMax } = parsePrefs(req.body || {});
    const { roster } = await generateRoster({ mode, budgetMin, budgetMax });
    const pdf = await generatePdfBuffer({ mode, budgetMin, budgetMax, roster });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename=FantaElite_${mode}.pdf`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Errore interno durante la generazione', detail: String(e) });
  }
});

// (facoltativo) Echo semplice KO-FI (utile se domani vorrai reintrodurre il webhook)
app.post('/debug/kofi-echo', (req, res) => {
  const h = req.headers || {};
  const envT = process.env.KOFI_VERIFICATION_TOKEN || '';
  const hdrT = req.get('X-Verification-Token') || req.get('x-verification-token') || '';
  const bodyRaw = req.body?.data || '';
  res.json({
    envTokenEndsWith: envT ? envT.slice(-6) : null,
    headerTokenEndsWith: hdrT ? hdrT.slice(-6) : null,
    receivedHeaders: h,
    receivedBody: typeof req.body === 'object' ? req.body : String(req.body)
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  // già loggato sopra
});

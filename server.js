// server.js — Flusso con Carrd + Ko-fi:
// Ko-fi pagamento → webhook /webhooks/kofi → invio email con link /success?ticket=...
// → pagina Successo mostra modulo → POST /api/generate (con ticket) → PDF + email
//
// Requisiti: Node 18+
// 1) npm i
// 2) Imposta le variabili d'ambiente (a fondo file)
// 3) node server.js → usa Carrd per il pagamento; Ko-fi chiamerà il webhook

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import OpenAI from 'openai';
import { Resend } from 'resend';

// ========== ENV ==========
const {
  PORT = '3000',
  PUBLIC_URL = 'http://localhost:3000',

  // protezione test/uso interno
  API_KEY = 'change-me',

  // OpenAI
  OPENAI_API_KEY = '',
  OPENAI_MODEL = 'gpt-4o-mini',

  // Email via Resend (opzionale ma consigliato)
  RESEND_API_KEY = '',
  FROM_EMAIL = '', // es: "FantaElite <noreply@tuodominio.it>"

  // Ko-fi Webhook
  KOFI_VERIFICATION_TOKEN = '', // DEVE combaciare con quello impostato su Ko-fi
} = process.env;

// ========== APP ==========
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ========== RATE LIMIT ==========
const limiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use('/api/', limiter);
app.use('/webhooks/', limiter);

// ========== INTEGRAZIONI ==========
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ========== PERSISTENZA SEMPLICE SU FILE ==========
const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ tickets: {}, transactions: {}, emails: {} }, null, 2));

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { tickets: {}, transactions: {}, emails: {} }; }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

// ========== UTILS TICKET ==========
function newId() { return crypto.randomBytes(16).toString('hex'); }
function now() { return Date.now(); }
const TICKET_TTL_MS = 1000 * 60 * 60 * 72; // 72h

function createTicketForEmail(email) {
  const store = loadStore();
  const id = newId();
  store.tickets[id] = {
    id,
    email,
    createdAt: now(),
    expiresAt: now() + TICKET_TTL_MS,
    used: false
  };
  if (!store.emails[email]) store.emails[email] = [];
  store.emails[email].push(id);
  saveStore(store);
  return id;
}
function markTicketUsed(id) {
  const store = loadStore();
  if (store.tickets[id]) {
    store.tickets[id].used = true;
    saveStore(store);
  }
}
function isTicketValid(id) {
  const store = loadStore();
  const t = store.tickets[id];
  if (!t) return { ok: false, reason: 'not_found' };
  if (t.used) return { ok: false, reason: 'used' };
  if (t.expiresAt < now()) return { ok: false, reason: 'expired' };
  return { ok: true, email: t.email };
}
function rememberTransaction(txId, email, ticketId) {
  const store = loadStore();
  store.transactions[txId] = { email, ticketId, at: now() };
  saveStore(store);
}

// ========== HEALTH ==========
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ========== HOME SEMPLICE (INFO) ==========
app.get('/', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FantaElite — Backend</title>
<style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 16px;color:#111}.card{border:1px solid #eee;padding:16px;border-radius:12px}</style>
</head>
<body>
<h1>FantaElite — Backend</h1>
<div class="card">
  <p>Landing su <strong>Carrd</strong>, pagamento su <strong>Ko-fi</strong>.</p>
  <p>Configura su Ko-fi il <strong>Webhook</strong> verso <code>${PUBLIC_URL}/webhooks/kofi</code> con il tuo <em>Verification Token</em>.</p>
  <p>Dopo il pagamento, invieremo una mail al cliente con il link a <code>/success?ticket=...</code>.</p>
</div>
</body></html>
`);
});

// ========== PAGINA SUCCESS (mostra MODULO) ==========
app.get('/success', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Genera la tua rosa</title>
<style>
  body{font-family:system-ui;max-width:900px;margin:40px auto;padding:0 16px;color:#111}
  .card{border:1px solid #eee;border-radius:12px;padding:16px;margin:16px 0;box-shadow:0 1px 8px rgba(0,0,0,.04)}
  label{display:block;margin:8px 0 4px}
  input,select{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px}
  button{padding:12px 16px;border:0;border-radius:10px;background:#111;color:#fff;cursor:pointer}
  .muted{color:#666;font-size:14px}
  .ok{color:green}.err{color:#b00}
</style>
</head>
<body>
  <h1>Genera la tua rosa</h1>
  <p class="muted" id="status">Verifico il tuo ticket...</p>

  <div class="card" id="formCard" style="display:none">
    <form id="genForm">
      <label>Modalità</label>
      <select name="mode">
        <option value="equilibrata">Equilibrata</option>
        <option value="aggressiva">Aggressiva</option>
        <option value="lowcost">Low Cost</option>
      </select>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
        <div>
          <label>Budget Min</label>
          <input name="budgetMin" type="number" value="380" min="1" />
        </div>
        <div>
          <label>Budget Max</label>
          <input name="budgetMax" type="number" value="520" min="1" />
        </div>
      </div>
      <label>Email per ricevere il PDF</label>
      <input name="email" type="email" placeholder="tu@esempio.it" required />
      <div style="margin-top:12px"><button type="submit">Genera e scarica PDF</button></div>
    </form>
    <p id="msg" class="muted"></p>
  </div>

<script>
(async () => {
  const p = new URLSearchParams(location.search);
  const ticket = p.get('ticket');
  const statusEl = document.getElementById('status');
  const card = document.getElementById('formCard');
  if (!ticket) { statusEl.innerHTML = '<span class="err">Ticket mancante</span>'; return; }
  try {
    const r = await fetch('/api/verify-ticket?ticket='+encodeURIComponent(ticket));
    const data = await r.json();
    if (data.valid) {
      statusEl.innerHTML = '<span class="ok">Ticket valido: compila il modulo qui sotto.</span>';
      card.style.display = 'block';
      const form = document.getElementById('genForm');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        msg.textContent = 'Genero la rosa...';
        const fd = new FormData(form);
        const payload = {
          ticket,
          mode: fd.get('mode'),
          budgetMin: Number(fd.get('budgetMin')),
          budgetMax: Number(fd.get('budgetMax')),
          email: fd.get('email'),
          demo: false
        };
        try {
          const r = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify(payload)
          });
          if (!r.ok) {
            const t = await r.text();
            msg.innerHTML = '<span class="err">Errore: '+t+'</span>';
            return;
          }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'FantaElite_'+payload.mode+'.pdf';
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          msg.innerHTML = '<span class="ok">PDF scaricato. Se hai inserito l’email, lo riceverai anche via mail.</span>';
        } catch (err) {
          msg.innerHTML = '<span class="err">Errore di rete: '+err.message+'</span>';
        }
      });
    } else {
      statusEl.innerHTML = '<span class="err">Ticket non valido: '+(data.reason||'')+'</span>';
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="err">'+e.message+'</span>';
  }
})();
</script>
</body>
</html>
`);
});

// ========== VERIFICA TICKET ==========
app.get('/api/verify-ticket', (req, res) => {
  const ticket = String(req.query.ticket || '');
  if (!ticket) return res.json({ valid: false, reason: 'missing' });
  const v = isTicketValid(ticket);
  res.json({ valid: v.ok, reason: v.reason || null });
});

// ========== WEBHOOK KO-FI ==========
/*
  Configura su Ko-fi:
  - Webhook URL:      ${PUBLIC_URL}/webhooks/kofi
  - Verification token: UGUALE a KOFI_VERIFICATION_TOKEN
  Ko-fi invia un JSON che include (tra gli altri) "verification_token", "email", "kofi_transaction_id", "type".
*/
const KoFiSchema = z.object({
  verification_token: z.string(),
  email: z.string().email().optional(),
  type: z.string().optional(), // Donation / Shop Order / Subscription Payment ecc.
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
  kofi_transaction_id: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  from_name: z.string().optional(),
  message: z.string().optional()
});

app.post('/webhooks/kofi', (req, res) => {
  try {
    const payload = KoFiSchema.parse(req.body || {});
    if (!KOFI_VERIFICATION_TOKEN) return res.status(400).send('Server non configurato (token mancante)');
    if (payload.verification_token !== KOFI_VERIFICATION_TOKEN) {
      return res.status(401).send('Token non valido');
    }
    const buyerEmail = payload.email;
    const txId = payload.kofi_transaction_id || `kofi_${newId()}`;

    // generiamo il ticket solo se abbiamo una email
    if (buyerEmail) {
      const ticket = createTicketForEmail(buyerEmail);
      rememberTransaction(txId, buyerEmail, ticket);

      // inviamo mail con link a /success?ticket=...
      if (resend && FROM_EMAIL) {
        resend.emails.send({
          from: FROM_EMAIL,
          to: buyerEmail,
          subject: "Il tuo accesso per generare la rosa — FantaElite",
          text: `Grazie per il pagamento su Ko-fi!\n\nClicca qui per generare la tua rosa:\n${PUBLIC_URL}/success?ticket=${ticket}\n\nIl link scade tra 72 ore.`
        }).catch(e => console.warn('Invio email (Ko-fi) fallito:', e?.message || e));
      }
    } else {
      console.warn('Webhook Ko-fi ricevuto ma senza email; impossibile inviare ticket.');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Errore webhook Ko-fi:', err?.message || err);
    res.status(400).send('Bad Request');
  }
});

// ========== VALIDAZIONE INPUT GENERAZIONE ==========
const GenSchema = z.object({
  mode: z.enum(['equilibrata','aggressiva','lowcost']),
  email: z.string().email().optional(),
  budgetMin: z.number().int().min(1),
  budgetMax: z.number().int().min(1),
  demo: z.boolean().optional(),
  ticket: z.string().optional(), // via flusso Ko-fi
  // alternativa test/uso interno
  session_id: z.string().optional() // compatibilità vecchi client (ignorato qui)
});

// ========== OPENAI: suggerisci rosa ==========
async function suggestRoster({ mode, budgetMin, budgetMax }) {
  if (!OPENAI_API_KEY) {
    // fallback statico per ambienti senza chiave
    return {
      P: ['Portiere A','Portiere B'],
      D: ['Difensore A','Difensore B','Difensore C','Difensore D','Difensore E'],
      C: ['Centrocampista A','Centrocampista B','Centrocampista C','Centrocampista D'],
      A: ['Attaccante A','Attaccante B','Attaccante C']
    };
  }
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const prompt = `
Sei un consulente Fantacalcio. Proponi una rosa COMPATTA in formato JSON con proprietà P,D,C,A (array di stringhe),
coerente con la strategia "${mode}" e budget indicativo min ${budgetMin} / max ${budgetMax}.
Rispondi SOLO con JSON valido. Esempio:
{"P":["...","..."],"D":["..."],"C":["..."],"A":["..."]}`;
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Rispondi SOLO con JSON valido come da esempio.' },
      { role: 'user', content: prompt }
    ]
  });
  const text = resp.choices?.[0]?.message?.content?.trim() || '{}';
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  const json = start >= 0 ? text.slice(start, end + 1) : '{}';
  let parsed = {};
  try { parsed = JSON.parse(json); } catch {}
  return {
    P: Array.isArray(parsed.P) && parsed.P.length ? parsed.P : ['Portiere A','Portiere B'],
    D: Array.isArray(parsed.D) && parsed.D.length ? parsed.D : ['Dif A','Dif B','Dif C','Dif D','Dif E'],
    C: Array.isArray(parsed.C) && parsed.C.length ? parsed.C : ['Cen A','Cen B','Cen C','Cen D'],
    A: Array.isArray(parsed.A) && parsed.A.length ? parsed.A : ['Att A','Att B','Att C']
  };
}

// ========== PDF ==========
function generatePdfBuffer({ mode, email, budgetMin, budgetMax, roster, demo }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text(`FantaElite — Strategia: ${mode}`);
    doc.moveDown(0.3).fontSize(10).fillColor('#555')
      .text(`Budget: ${budgetMin}-${budgetMax}  |  Email: ${email || 'n/d'}  |  Data: ${new Date().toLocaleString('it-IT')}`);
    doc.moveDown(0.8).fillColor('#000');

    const section = (titolo, items) => {
      doc.fontSize(16).text(titolo);
      doc.moveDown(0.2).fontSize(12).fillColor('#333');
      items.forEach(n => doc.text('• ' + n));
      doc.moveDown(0.6).fillColor('#000');
    };
    section('P — Portieri', roster.P);
    section('D — Difensori', roster.D);
    section('C — Centrocampisti', roster.C);
    section('A — Attaccanti', roster.A);

    doc.moveDown(0.5).fontSize(10).fillColor('#666')
      .text('Nota: rosa generata automaticamente in base ai parametri. Adattala alla tua lega.');

    if (demo) {
      doc.rotate(35, { origin: [300, 400] })
         .fontSize(58).fillColor('rgba(200,200,200,0.4)')
         .text('DEMO', 80, 250, { align: 'center' })
         .rotate(-35);
    }

    doc.end();
  });
}

// ========== API: GENERATE ==========
app.post('/api/generate', async (req, res) => {
  try {
    const clean = {
      ...req.body,
      budgetMin: Number(req.body?.budgetMin),
      budgetMax: Number(req.body?.budgetMax),
      demo: Boolean(req.body?.demo)
    };
    const p = GenSchema.parse(clean);
    if (p.budgetMax < p.budgetMin) {
      return res.status(400).json({ error: 'budgetMax deve essere >= budgetMin' });
    }

    // Autorizzazione:
    // A) flusso Ko-fi: ticket valido
    // B) test interno: Authorization: Bearer <API_KEY>
    let authorized = false;
    let emailFromTicket = null;

    const auth = req.header('Authorization') || '';
    if (auth === `Bearer ${API_KEY}`) {
      authorized = true;
    } else if (p.ticket) {
      const v = isTicketValid(p.ticket);
      if (v.ok) {
        authorized = true;
        emailFromTicket = v.email;
        // opzionale: consumare il ticket ad ogni generazione:
        markTicketUsed(p.ticket);
      }
    }

    if (!authorized) {
      return res.status(401).json({ error: 'Non autorizzato (servono ticket valido o API_KEY)' });
    }

    const roster = await suggestRoster(p);
    const pdfBuffer = await generatePdfBuffer({
      ...p,
      email: p.email || emailFromTicket || null,
      roster
    });

    // Email (se configurato) — mandiamo solo se abbiamo una mail
    const sendTo = p.email || emailFromTicket;
    if (resend && FROM_EMAIL && sendTo) {
      resend.emails.send({
        from: FROM_EMAIL,
        to: sendTo,
        subject: `La tua rosa FantaElite — ${p.mode}`,
        text: `In allegato trovi il PDF della tua rosa.\n\nStrategia: ${p.mode}\nBudget: ${p.budgetMin}-${p.budgetMax}\n\nBuon Fantacalcio!`,
        attachments: [{
          filename: `FantaElite_${p.mode}.pdf`,
          content: pdfBuffer.toString('base64')
        }]
      }).catch(e => console.warn('Invio email fallito:', e?.message || e));
    }

    // Risposta (download)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FantaElite_${p.mode}.pdf"`);
    res.end(pdfBuffer);

  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ error: 'Parametri non validi', details: err.issues });
    }
    console.error('Errore /api/generate:', err);
    res.status(500).send('Errore interno durante la generazione');
  }
});

// ========== START ==========
app.listen(Number(PORT), () => {
  console.log(`✅ Backend pronto su ${PUBLIC_URL} (porta ${PORT})`);
  if (!KOFI_VERIFICATION_TOKEN) console.log('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi.');
  if (!OPENAI_API_KEY) console.log('⚠️  OPENAI_API_KEY mancante: userò roster di fallback statico.');
  if (RESEND_API_KEY && !FROM_EMAIL) console.log('⚠️  RESEND_API_KEY presente ma FROM_EMAIL mancante: email disabilitata.');
});

/*
===========================
 Variabili d'ambiente (PowerShell)
===========================
$env:PORT="3000"
$env:PUBLIC_URL="http://localhost:3000"
$env:API_KEY="abc123!fantaElite2025"

# OpenAI
$env:OPENAI_API_KEY="LA_TUA_CHIAVE_OPENAI"
$env:OPENAI_MODEL="gpt-4o-mini"

# Resend (email) — opzionale ma consigliato
$env:RESEND_API_KEY="re_..."
$env:FROM_EMAIL="FantaElite <noreply@tuodominio.it>"

# Ko-fi
$env:KOFI_VERIFICATION_TOKEN="metti-qui-lo-stesso-token-che-imposti-in-ko-fi"
*/

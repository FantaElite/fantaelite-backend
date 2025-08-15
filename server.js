// server.js
// Avvio: node server.js
// Dipendenze: npm i express
// Node consigliato: >= 18 (usa crypto.randomUUID)

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================
// CONFIG
// ============================
const PORT = process.env.PORT || 3000;
// Usa la stessa chiave che usi dal client
const API_KEY = process.env.API_KEY || 'abc123!fantaElite2025';

// ============================
// LISTINO PREZZI (ESEMPIO)
// ============================
// Puoi sostituire con il tuo listino ufficiale o caricarlo da DB.
// Qui ho messo valori coerenti con una strategia "equilibrata" e
// un totale intorno a 386 crediti (nel range 380–520 del tuo test).
const LISTINO = new Map([
  // P
  ['Musso', 12],
  ['Audero', 8],
  ['Chichizola', 3],

  // D
  ['Perez N.', 10],
  ['Martinez Quarta', 22],
  ['Dorgu', 13],
  ['Abankwah', 2],
  ['Dahl', 2],
  ['Bakker', 8],
  ['Godfrey', 8],
  ['Azzi', 5],

  // C
  ['Iling Junior', 15],
  ['Mazzitelli', 12],
  ['Andersen M.K.', 10],
  ['Melegoni', 4],
  ['Kone B.', 4],
  ['Pereiro', 7],
  ['Le Fee', 16],
  ['Buchanan T.', 8],

  // A
  ['Kvaratskhelia', 80],
  ['Morata', 60],
  ['Pohjanpalo', 50],
  ['Belotti', 22],
  ['Ankeye', 1],
  ['Raimondo', 4],
]);

// ============================
// UTILITY
// ============================
const round1 = (n) => Math.round(n * 10) / 10;
const nowIso = () => new Date().toISOString();
const ensureBearer = (req) => {
  const hdr = req.header('Authorization') || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

function groupBy(arr, keyFn) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x);
    (acc[k] ||= []).push(x);
    return acc;
  }, {});
}

function computeBudget(rosa) {
  let totale = 0;
  const perRuolo = { P: 0, D: 0, C: 0, A: 0 };

  for (const p of rosa) {
    const c = Number(p.crediti || 0);
    totale += c;
    perRuolo[p.ruolo] += c;
  }

  const percentuali = {
    P: totale ? round1((perRuolo.P * 100) / totale) : 0,
    D: totale ? round1((perRuolo.D * 100) / totale) : 0,
    C: totale ? round1((perRuolo.C * 100) / totale) : 0,
    A: totale ? round1((perRuolo.A * 100) / totale) : 0,
  };

  return { totale, perRuolo, percentuali };
}

function attachPrices(rosa, listino) {
  const missing = [];
  for (const p of rosa) {
    const prezzo = listino.get(p.giocatore);
    if (typeof prezzo === 'number') {
      p.crediti = prezzo;
    } else {
      p.crediti = 0;
      missing.push({ ruolo: p.ruolo, giocatore: p.giocatore, squadra: p.squadra });
    }
  }
  return missing;
}

// ============================
// GENERATORE ROSA (HOOK)
// ============================
// Se hai già un generatore tuo, sostituisci SOLO il contenuto
// di questa funzione e restituisci un array di giocatori con
// questi campi: ruolo, giocatore, squadra, fantam, partite.
function generateRoster({ mode }) {
  // Per coerenza con il PDF “Equilibrata”
  // Restituisco esattamente quei 25 profili.
  // Puoi ignorare 'mode' o usarlo per logiche alternative.
  const ROSA = [
    // P
    { ruolo: 'P', giocatore: 'Musso', squadra: 'Atalanta',  fantam: 6.00, partite: 1 },
    { ruolo: 'P', giocatore: 'Audero', squadra: 'Como',     fantam: 3.75, partite: 8 },
    { ruolo: 'P', giocatore: 'Chichizola', squadra: 'Parma',fantam: 2.00, partite: 1 },

    // D
    { ruolo: 'D', giocatore: 'Perez N.', squadra: 'Udinese',          fantam: 6.25, partite: 2 },
    { ruolo: 'D', giocatore: 'Martinez Quarta', squadra: 'Fiorentina',fantam: 6.21, partite: 7 },
    { ruolo: 'D', giocatore: 'Dorgu', squadra: 'Lecce',                fantam: 6.12, partite: 21 },
    { ruolo: 'D', giocatore: 'Abankwah', squadra: 'Udinese',           fantam: 6.00, partite: 2 },
    { ruolo: 'D', giocatore: 'Dahl', squadra: 'Roma',                  fantam: 6.00, partite: 2 },
    { ruolo: 'D', giocatore: 'Bakker', squadra: 'Atalanta',            fantam: 6.00, partite: 1 },
    { ruolo: 'D', giocatore: 'Godfrey', squadra: 'Atalanta',           fantam: 6.00, partite: 1 },
    { ruolo: 'D', giocatore: 'Azzi', squadra: 'Cagliari',              fantam: 5.83, partite: 6 },

    // C
    { ruolo: 'C', giocatore: 'Iling Junior', squadra: 'Bologna',   fantam: 6.75, partite: 4 },
    { ruolo: 'C', giocatore: 'Mazzitelli', squadra: 'Como',        fantam: 6.44, partite: 8 },
    { ruolo: 'C', giocatore: 'Andersen M.K.', squadra: 'Venezia',  fantam: 6.23, partite: 13 },
    { ruolo: 'C', giocatore: 'Melegoni', squadra: 'Genoa',         fantam: 6.00, partite: 3 },
    { ruolo: 'C', giocatore: 'Kone B.', squadra: 'Como',           fantam: 6.00, partite: 1 },
    { ruolo: 'C', giocatore: 'Pereiro', squadra: 'Genoa',          fantam: 6.00, partite: 1 },
    { ruolo: 'C', giocatore: 'Le Fee', squadra: 'Roma',            fantam: 5.90, partite: 5 },
    { ruolo: 'C', giocatore: 'Buchanan T.', squadra: 'Inter',      fantam: 5.83, partite: 3 },

    // A
    { ruolo: 'A', giocatore: 'Kvaratskhelia', squadra: 'Napoli',   fantam: 7.24, partite: 17 },
    { ruolo: 'A', giocatore: 'Morata', squadra: 'Milan',           fantam: 6.88, partite: 16 },
    { ruolo: 'A', giocatore: 'Pohjanpalo', squadra: 'Venezia',     fantam: 6.78, partite: 20 },
    { ruolo: 'A', giocatore: 'Belotti', squadra: 'Como',           fantam: 6.42, partite: 12 },
    { ruolo: 'A', giocatore: 'Ankeye', squadra: 'Genoa',           fantam: 6.00, partite: 1 },
    { ruolo: 'A', giocatore: 'Raimondo', squadra: 'Venezia',       fantam: 6.00, partite: 1 },
  ];

  return ROSA;
}

// ============================
// API
// ============================

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fantaelite-backend', time: nowIso() });
});

app.post('/api/test-generate', (req, res) => {
  try {
    // 1) Autenticazione
    const token = ensureBearer(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing Authorization header (Bearer ...)' });
    }
    if (token !== API_KEY) {
      return res.status(403).json({ ok: false, error: 'Invalid API key' });
    }

    // 2) Input
    const { mode = 'equilibrata', email = null, budgetMin = 0, budgetMax = 1000 } = req.body || {};
    const seed = crypto.randomUUID();

    // 3) Genera rosa
    const rosa = generateRoster({ mode, email, seed });

    // 4) Aggancia prezzi
    const missingPrices = attachPrices(rosa, LISTINO);

    // 5) Calcoli budget
    const { totale, perRuolo, percentuali } = computeBudget(rosa);

    // 6) Validazioni budget
    const withinRange = (totale >= Number(budgetMin)) && (totale <= Number(budgetMax));
    const diffFromMin = totale - Number(budgetMin);
    const diffFromMax = Number(budgetMax) - totale;

    // 7) Info sintetiche utili al PDF
    const counts = Object.fromEntries(
      Object.entries(groupBy(rosa, x => x.ruolo)).map(([r, xs]) => [r, xs.length])
    );

    // 8) Response
    res.json({
      ok: true,
      mode,
      email,
      seed,
      generatedAt: nowIso(),
      rosa, // ogni giocatore ora ha anche `crediti`
      riepilogo: {
        numerosita: counts,              // es. { P:3, D:8, C:8, A:6 }
        totaleCrediti: totale,           // es. 386
        spesaPerRuolo: perRuolo,         // es. { P:23, D:70, C:76, A:217 }
        percentualiPerRuolo: percentuali // es. { P:6.0, D:18.1, C:19.7, A:56.2 }
      },
      budget: {
        richiesto: { min: Number(budgetMin), max: Number(budgetMax) },
        calcolato: totale,
        withinRange,
        diffFromMin,
        diffFromMax
      },
      warnings: {
        missingPrices, // se vuoto, il listino copre tutti i giocatori
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Internal error', detail: String(err?.message || err) });
  }
});

// ============================
// AVVIO
// ============================
app.listen(PORT, () => {
  console.log(`[fantaelite-backend] Listening on http://localhost:${PORT}`);
  console.log(`[fantaelite-backend] API_KEY: ${API_KEY ? 'set' : 'missing'}`);
});

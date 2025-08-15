import express from "express";
import crypto from "crypto";
import JSZip from "jszip";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

// === ENV ===
const {
  API_KEY, KOFI_WEBHOOK_SECRET, KOFI_API_KEY,
  SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  MAIL_FROM, MAIL_USER, MAIL_PASS, SMTP_HOST, SMTP_PORT
} = process.env;

// === SMTP ===
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || "smtp.gmail.com",
  port: Number(SMTP_PORT || 465),
  secure: true,
  auth: { user: MAIL_USER, pass: MAIL_PASS }
});

// === Google Sheets client (Service Account) ===
const auth = new google.auth.JWT(
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  undefined,
  (GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets.readonly"]
);
const sheets = google.sheets({ version: "v4", auth });

// === Cache semplice (10 minuti) ===
let CACHE = { at: 0, rows: [] };
async function readPlayers() {
  const now = Date.now();
  if (now - CACHE.at < 10 * 60 * 1000 && CACHE.rows.length) return CACHE.rows;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Database Fantacalcio!A:G"
  });

  const values = res.data.values || [];
  if (!values.length) return [];

  const [header, ...data] = values;
  const idx = Object.fromEntries(header.map((h, i) => [String(h || "").trim(), i]));

  const rows = data
    .map(r => ({
      Nome: r[idx["Nome"]],
      Squadra: r[idx["Squadra"]],
      Ruolo: r[idx["Ruolo"]],
      Media_Voto: toNum(r[idx["Media_Voto"]]),
      Fantamedia: toNum(r[idx["Fantamedia"]]),
      Quotazione: toNum(r[idx["Quotazione"]]),
      Partite_Voto: toNum(r[idx["Partite_Voto"]])
    }))
    // filtra righe senza dati utili (tranne Quotazione, che può essere 0)
    .filter(x => x && x.Nome && x.Ruolo && (x.Partite_Voto > 0 || x.Fantamedia > 0));

  CACHE = { at: now, rows };
  return rows;
}
function toNum(v) {
  if (v == null || v === "") return 0;
  return Number(String(v).replace(".", "").replace(",", ".")) || 0;
}

// === Config & util ===
const CFG = {
  budgetMin: 380,
  budgetMax: 500,        // puoi alzare a 520 se i tuoi dati sono “costosi”
  maxTries: 500,         // aumentato da 150 a 500
  rolesCount: { P: 3, D: 8, C: 8, A: 6 },
  pct: {
    equilibrata: { P:[0.04,0.08], D:[0.08,0.14], C:[0.20,0.30], A:[0.56,0.64] },
    moddifesa:   { P:[0.08,0.10], D:[0.18,0.20], C:[0.30,0.32], A:[0.40,0.42] }
  }
};
function sum(arr){ return arr.reduce((s,p)=>s+(p.Quotazione||0),0); }
function hashSeed(s){ return [...Buffer.from(s)].reduce((a,b)=>((a<<5)-a+b)>>>0, 2166136261); }
function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }

function pickTeam(players, mode, seed = crypto.randomUUID(), budgetMin = CFG.budgetMin, budgetMax = CFG.budgetMax) {
  const rng = mulberry32(hashSeed(seed));
  const byRole = { P:[], D:[], C:[], A:[] };
  players.forEach(p => { if (byRole[p.Ruolo]) byRole[p.Ruolo].push(p); });

  // Ordina per priorità: Partite_Voto, Fantamedia, Quotazione
  Object.values(byRole).forEach(arr =>
    arr.sort((a,b) =>
      (b.Partite_Voto - a.Partite_Voto) ||
      (b.Fantamedia - a.Fantamedia) ||
      (b.Quotazione - a.Quotazione)
    )
  );

  // Traccia il miglior candidato anche se non perfetto
  let best = null;
  let bestScore = Infinity;

  const scoreCandidate = (team, total, pctSpent) => {
    // Penalità budget: distanza dal range
    let budgetPenalty = 0;
    if (total < budgetMin) budgetPenalty = (budgetMin - total);
    else if (total > budgetMax) budgetPenalty = (total - budgetMax);

    // Penalità percentuali: distanza fuori dai range base (più è fuori, peggio è)
    const base = CFG.pct[mode];
    const pctPenalty = ["P","D","C","A"].reduce((acc, r) => {
      const lo = base[r][0], hi = base[r][1];
      const v = pctSpent[r];
      if (v < lo) return acc + (lo - v) * 1000;  // pesi alti per rispetto % ruolo
      if (v > hi) return acc + (v - hi) * 1000;
      return acc;
    }, 0);

    // Penalità squilibri interni (facoltativo: somma varianza)
    const balancePenalty = Math.abs(pctSpent.P - base.P[0]) + Math.abs(pctSpent.D - base.D[0]) + Math.abs(pctSpent.C - base.C[0]) + Math.abs(pctSpent.A - base.A[0]);

    return budgetPenalty * 10 + pctPenalty + balancePenalty; // mix di pesi
  };

  for (let t=0; t<CFG.maxTries; t++) {
    const team = { P:[], D:[], C:[], A:[] };

    ["P","D","C","A"].forEach(R=>{
      const need = CFG.rolesCount[R];
      let pool = byRole[R].slice(0, Math.min(120, byRole[R].length)); // pool 120
      while (team[R].length < need && pool.length) {
        const i = Math.floor(rng()*pool.length);
        team[R].push(pool.splice(i,1)[0]);
      }
    });

    const flat = [...team.P, ...team.D, ...team.C, ...team.A];
    if (flat.length !== 25) continue;

    const total = flat.reduce((s,p)=>s+(p.Quotazione||0),0);
    const pctSpent = {
      P: sum(team.P)/total, D: sum(team.D)/total,
      C: sum(team.C)/total, A: sum(team.A)/total
    };

    // 1) Prova range stretti
    const base = CFG.pct[mode];
    const within = (r, tilt=0) => {
      const lo = Math.max(0, base[r][0] - tilt);
      const hi = Math.min(1, base[r][1] + tilt);
      return pctSpent[r] >= lo && pctSpent[r] <= hi;
    };
    const okStrict   = ["P","D","C","A"].every(r => within(r, 0));
    const okSoft02   = ["P","D","C","A"].every(r => within(r, 0.02));
    const okSoft05   = ["P","D","C","A"].every(r => within(r, 0.05));

    if (total >= budgetMin && total <= budgetMax && (okStrict || okSoft02 || okSoft05)) {
      return { team, total, pctSpent, seed }; // trovato valido → esci
    }

    // 2) Aggiorna best candidate
    const s = scoreCandidate(team, total, pctSpent);
    if (s < bestScore) { bestScore = s; best = { team, total, pctSpent, seed }; }
  }

  // 3) Fallback: restituisci il migliore trovato (mai errore)
  if (best) return best;

  // Estremo: nessun candidato (dataset vuoto)
  throw new Error("Impossibile generare la rosa: dataset insufficiente");
}

// === PDF (pdfkit) ===
function renderPdf({ mode, payload }) {
  const { team, total, pctSpent, seed } = payload;
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    // Header
    doc.fontSize(18).text(`FantaElite — ${mode === "equilibrata" ? "Rosa Equilibrata" : "Modificatore Difesa"}`, { align:"left" });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#555").text(`Data: ${new Date().toLocaleString("it-IT")}`);
    doc.text(`Seed: ${seed}`);
    doc.moveDown();

    // Tabella
    drawTable(doc, team);

    // Totali
    doc.moveDown();
    doc.fontSize(12).fillColor("#000").text(`Totale crediti: ${total}`);
    doc.fontSize(10).fillColor("#333").text(`Spesa per ruolo: P ${(pctSpent.P*100).toFixed(1)}% • D ${(pctSpent.D*100).toFixed(1)}% • C ${(pctSpent.C*100).toFixed(1)}% • A ${(pctSpent.A*100).toFixed(1)}%`);
    doc.moveDown(1);
    doc.fontSize(8).fillColor("#666").text("Nota: rosa generata automaticamente in base a dati, budget e vincoli impostati.", { align:"left" });

    doc.end();
  });
}
function drawTable(doc, team){
  const rows = [
    ["RUOLO","GIOCATORE","SQUADRA","FANTAM.","PARTITE","CREDITI"],
    ...["P","D","C","A"].flatMap(R =>
      team[R].map(p => [R, p.Nome, p.Squadra, fmt(p.Fantamedia), fmt(p.Partite_Voto), fmt(p.Quotazione)]))
  ];
  const colW = [50, 180, 100, 80, 70, 70];
  let y = doc.y + 5, x = doc.x;
  rows.forEach((r, idx) => {
    const isHeader = idx === 0;
    if (isHeader) doc.rect(x, y-3, colW.reduce((a,b)=>a+b,0), 22).fill("#f2f2f2").fillColor("#000");
    r.forEach((cell, i) => {
      doc.fontSize(isHeader?10:9).fillColor(isHeader?"#000":"#111")
         .text(String(cell), x + colW.slice(0,i).reduce((a,b)=>a+b,0) + 6, y, { width: colW[i]-10 });
    });
    y += 20;
    doc.moveTo(x, y-2).lineTo(x + colW.reduce((a,b)=>a+b,0), y-2).strokeColor("#e5e5e5").stroke();
  });
}
function fmt(v){ return (v ?? 0).toString().replace(".", ","); }

// === Email helper ===
async function sendEmail(to, subject, text, attachments){
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, attachments });
}

// === Home & Health ===
app.get("/", (req, res) => {
  res.type("text/plain").send("FantaElite backend: online ✅\n- POST /api/test-generate\n- POST /webhook/kofi");
});
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fantaelite-backend", time: new Date().toISOString() });
});

// === Test solo email (utile per debug SMTP) ===
app.post("/api/test-email", async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return res.status(401).end();
    const to = (req.query.to || "tua_email@esempio.it").toString();
    await transporter.sendMail({
      from: MAIL_FROM,
      to,
      subject: "FantaElite — Test email",
      text: "Se ricevi questa, l'SMTP è OK 👍"
    });
    res.json({ ok: true, sent: to });
  } catch (e) {
    console.error("TEST-EMAIL ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === Test generate (manuale) ===
// accetta facoltativamente budgetMin/budgetMax per sbloccare dataset “costosi”
app.post("/api/test-generate", async (req,res)=>{
  try{
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return res.status(401).end();
    const { mode="equilibrata", email, budgetMin, budgetMax } = req.body || {};
    if (!email) return res.status(400).json({ error:"email richiesta" });

    const players = await readPlayers();
    const seed = crypto.randomUUID();

    if (mode === "complete"){
      // Equilibrata
      const one = pickTeam(players, "equilibrata", seed, budgetMin || CFG.budgetMin, budgetMax || CFG.budgetMax);

      // ModDifesa con diversità >=60%
      let two;
      for (let i=0;i<CFG.maxTries;i++){
        const tmp = pickTeam(players, "moddifesa", crypto.randomUUID(), budgetMin || CFG.budgetMin, budgetMax || CFG.budgetMax);
        const baseNames = new Set([...one.team.P, ...one.team.D, ...one.team.C, ...one.team.A].map(p=>p.Nome));
        const twoFlat = [...tmp.team.P,...tmp.team.D,...tmp.team.C,...tmp.team.A].map(p=>p.Nome);
        const inter = twoFlat.filter(n=>baseNames.has(n)).length;
        const uniq = 25;
        if (inter/uniq <= 0.4) { two = tmp; break; } // <=40% overlap → >=60% diversi
      }
      if (!two) throw new Error("Impossibile garantire diversità >=60%");

      const [pdf1, pdf2] = await Promise.all([
        renderPdf({ mode: "equilibrata", payload: one }),
        renderPdf({ mode: "moddifesa",   payload: two })
      ]);

      const zip = new JSZip();
      zip.file(`FantaElite_Equilibrata.pdf`, pdf1);
      zip.file(`FantaElite_ModDifesa.pdf`, pdf2);
      const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

      await sendEmail(email,
        "FantaElite — Le tue rose (Equilibrata + Mod. Difesa)",
        "Grazie per l'acquisto! In allegato trovi i PDF delle due rose.",
        [{ filename:"FantaElite_Rose.zip", content: zipBuf }]
      );
    } else {
      const out = pickTeam(players, mode, seed, budgetMin || CFG.budgetMin, budgetMax || CFG.budgetMax);
      const pdf = await renderPdf({ mode, payload: out });
      await sendEmail(email,
        `FantaElite — La tua rosa (${mode === "equilibrata"?"Equilibrata":"Mod. Difesa"})`,
        "Grazie per l'acquisto! In allegato trovi il PDF della tua rosa.",
        [{ filename:`FantaElite_${mode==="equilibrata"?"Equilibrata":"ModDifesa"}.pdf`, content: pdf }]
      );
    }

    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// === Webhook Ko-fi ===
app.post("/webhook/kofi", async (req, res) => {
  try {
    // Firma Ko-fi: per i primi test puoi lasciare vuoto KOFI_WEBHOOK_SECRET
    const provided = (req.headers["x-ko-fi-signature"] || req.headers["x-kofi-signature"] || "").toString();
    if (KOFI_WEBHOOK_SECRET && provided !== KOFI_WEBHOOK_SECRET) {
      return res.status(401).json({ ok:false, error:"Firma non valida" });
    }

    const ev = req.body || {};
    // prova vari possibili campi email
    const email = (ev.email || ev.payer_email || ev.from || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:"Email mancante nel webhook" });

    // riconoscimento prodotto
    const label = [ev.item, ev.tier, ev.shop_item, ev.message].filter(Boolean).join(" ").toLowerCase();
    const isComplete = /complete/.test(label) || /(equilibrata).*(mod|difesa)/.test(label);
    const mode = isComplete ? "complete" :
                 /equilibrata/.test(label) ? "equilibrata" :
                 /(mod|difesa)/.test(label) ? "moddifesa" : null;
    if (!mode) return res.status(400).json({ ok:false, error:"Prodotto non riconosciuto" });

    const players = await readPlayers();
    const seed = crypto.randomUUID();

    if (mode === "complete") {
      const one = pickTeam(players, "equilibrata", seed);
      let two;
      for (let i=0;i<CFG.maxTries;i++){
        const tmp = pickTeam(players, "moddifesa", crypto.randomUUID());
        const overlap = new Set([...one.team.P, ...one.team.D, ...one.team.C, ...one.team.A].map(p=>p.Nome));
        const twoFlat = [...tmp.team.P,...tmp.team.D,...tmp.team.C,...tmp.team.A].map(p=>p.Nome);
        const inter = twoFlat.filter(n=>overlap.has(n)).length;
        const uniq = 25;
        if (inter/uniq <= 0.4) { two = tmp; break; }
      }
      if (!two) throw new Error("Impossibile garantire diversità >=60%");

      const [pdf1, pdf2] = await Promise.all([
        renderPdf({ mode: "equilibrata", payload: one }),
        renderPdf({ mode: "moddifesa",   payload: two })
      ]);

      const zip = new JSZip();
      zip.file(`FantaElite_Equilibrata.pdf`, pdf1);
      zip.file(`FantaElite_ModDifesa.pdf`, pdf2);
      const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

      await sendEmail(email,
        "FantaElite — Le tue rose (Equilibrata + Mod. Difesa)",
        "Grazie per l'acquisto! In allegato trovi i PDF delle due rose.",
        [{ filename:"FantaElite_Rose.zip", content: zipBuf }]
      );
    } else {
      const out = pickTeam(players, mode, seed);
      const pdf = await renderPdf({ mode, payload: out });
      await sendEmail(email,
        `FantaElite — La tua rosa (${mode === "equilibrata"?"Equilibrata":"Mod. Difesa"})`,
        "Grazie per l'acquisto! In allegato trovi il PDF della tua rosa.",
        [{ filename:`FantaElite_${mode==="equilibrata"?"Equilibrata":"ModDifesa"}.pdf`, content: pdf }]
      );
    }

    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  }
});
app.get("/debug/dataset", async (req, res) => {
  try {
    const players = await readPlayers();
    const byR = { P:[], D:[], C:[], A:[] };
    players.forEach(p => { if (byR[p.Ruolo]) byR[p.Ruolo].push(p); });
    const stat = (arr) => {
      if (!arr.length) return { count:0, min:0, p25:0, median:0, p75:0, max:0 };
      const prices = arr.map(x=>x.Quotazione||0).sort((a,b)=>a-b);
      const q = (k)=> prices[Math.floor(k*(prices.length-1))] || 0;
      return {
        count: arr.length,
        min: prices[0],
        p25: q(0.25),
        median: q(0.5),
        p75: q(0.75),
        max: prices[prices.length-1]
      };
    };
    res.json({
      totals: { all: players.length, P: byR.P.length, D: byR.D.length, C: byR.C.length, A: byR.A.length },
      priceStats: { P: stat(byR.P), D: stat(byR.D), C: stat(byR.C), A: stat(byR.A) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// === Avvio server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("FantaElite backend avviato su porta", PORT));

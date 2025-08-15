import express from "express";
import crypto from "crypto";
import JSZip from "jszip";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- ENV ---
const {
  API_KEY, KOFI_WEBHOOK_SECRET, KOFI_API_KEY,
  SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  MAIL_FROM, MAIL_USER, MAIL_PASS, SMTP_HOST, SMTP_PORT
} = process.env;

// --- SMTP ---
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || "smtp.gmail.com",
  port: Number(SMTP_PORT || 465),
  secure: true,
  auth: { user: MAIL_USER, pass: MAIL_PASS }
});

// --- Google Sheets client ---
const auth = new google.auth.JWT(
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  undefined,
  (GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets.readonly"]
);
const sheets = google.sheets({ version: "v4", auth });

// Cache semplice 10 minuti
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
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

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
    // filtra righe con zeri anomali (tranne Quotazione)
    .filter(x => x && x.Nome && x.Ruolo && (x.Partite_Voto > 0 || x.Fantamedia > 0));

  CACHE = { at: now, rows };
  return rows;
}

function toNum(v) {
  if (v == null || v === "") return 0;
  return Number(String(v).replace(".", "").replace(",", ".")) || 0;
}

// --- Algoritmo rosa (placeholder base) ---
const CFG = {
  budgetMin: 380, budgetMax: 500, maxTries: 500,
  rolesCount: { P: 3, D: 8, C: 8, A: 6 },
  pct: {
    equilibrata: { P:[0.04,0.08], D:[0.08,0.14], C:[0.20,0.30], A:[0.56,0.64] },
    moddifesa:   { P:[0.08,0.10], D:[0.18,0.20], C:[0.30,0.32], A:[0.40,0.42] }
  }
};

function pickTeam(players, mode, seed = crypto.randomUUID()) {
  const rng = mulberry32(hashSeed(seed));
  const byRole = { P:[], D:[], C:[], A:[] };
  players.forEach(p => { if (byRole[p.Ruolo]) byRole[p.Ruolo].push(p); });
  Object.values(byRole).forEach(arr =>
    arr.sort((a,b) =>
      (b.Partite_Voto - a.Partite_Voto) ||
      (b.Fantamedia - a.Fantamedia) ||
      (b.Quotazione - a.Quotazione)
    )
  );

  for (let t=0; t<CFG.maxTries; t++) {
    const team = { P:[], D:[], C:[], A:[] };
    ["P","D","C","A"].forEach(R=>{
      const need = CFG.rolesCount[R];
      let pool = byRole[R].slice(0, Math.min(120, byRole[R].length));
      while (team[R].length < need && pool.length) {
        const i = Math.floor(rng()*pool.length);
        team[R].push(pool.splice(i,1)[0]);
      }
    });
    const flat = [...team.P, ...team.D, ...team.C, ...team.A];
    const total = flat.reduce((s,p)=>s+(p.Quotazione||0),0);
    if (total < CFG.budgetMin || total > CFG.budgetMax) continue;

    const pctSpent = {
      P: sum(team.P)/total, D: sum(team.D)/total,
      C: sum(team.C)/total, A: sum(team.A)/total
    };
    const range = CFG.pct[mode];
    const ok = ["P","D","C","A"].every(r => pctSpent[r] >= range[r][0] && pctSpent[r] <= range[r][1]);
    if (!ok) continue;

    return { team, total, pctSpent, seed };
  }
  throw new Error("Impossibile generare la rosa entro i tentativi massimi");
}
function sum(arr){ return arr.reduce((s,p)=>s+(p.Quotazione||0),0); }
function hashSeed(s){ return [...Buffer.from(s)].reduce((a,b)=>((a<<5)-a+b)>>>0, 2166136261); }
function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }

// --- PDF (pdfkit) ---
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

// --- Email ---
async function sendEmail(to, subject, text, attachments){
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, attachments });
}

// --- Webhook Ko-fi ---
app.post("/webhook/kofi", async (req, res) => {
  try {
    // Firma: per il primo test NON impostare KOFI_WEBHOOK_SECRET
    const provided = (req.headers["x-ko-fi-signature"] || req.headers["x-kofi-signature"] || "").toString();
    if (KOFI_WEBHOOK_SECRET && provided !== KOFI_WEBHOOK_SECRET) {
      return res.status(401).json({ ok:false, error:"Firma non valida" });
    }

    const ev = req.body || {};
    // Prova a leggere vari possibili campi email
    const email = (ev.email || ev.payer_email || ev.from || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:"Email mancante nel webhook" });

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
        const overlap = new Set(one.team.P.concat(one.team.D,one.team.C,one.team.A).map(p=>p.Nome));
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

    return res.json({ ok:true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// --- Test interno (rimuovere in produzione) ---
app.post("/api/test-generate", async (req,res)=>{
  try{
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return res.status(401).end();
    const { mode="equilibrata", email } = req.body || {};
    if (!email) return res.status(400).json({ error:"email richiesta" });

    const players = await readPlayers();
    const seed = crypto.randomUUID();

    if (mode === "complete"){
      const one = pickTeam(players, "equilibrata", seed);
      const two = pickTeam(players, "moddifesa", crypto.randomUUID());
      const pdf1 = await renderPdf({ mode:"equilibrata", payload: one });
      const pdf2 = await renderPdf({ mode:"moddifesa", payload: two });
      const zip = new JSZip();
      zip.file(`FantaElite_Equilibrata.pdf`, pdf1);
      zip.file(`FantaElite_ModDifesa.pdf`, pdf2);
      const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
      await sendEmail(email, `FantaElite — Test (complete)`, "Allegato ZIP test.", [
        { filename:`FantaElite_Rose.zip`, content: zipBuf }
      ]);
    } else {
      const out = pickTeam(players, mode, seed);
      const pdf = await renderPdf({ mode, payload: out });
      await sendEmail(email, `FantaElite — Test (${mode})`, "Allegato PDF test.", [
        { filename:`FantaElite_${mode}.pdf`, content: pdf }
      ]);
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:e.message }); }
});
// Home (solo info)
app.get("/", (req, res) => {
  res.type("text/plain").send("FantaElite backend: online ✅\n- POST /api/test-generate\n- POST /webhook/kofi");
});

// Health check (per te o Render)
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fantaelite-backend", time: new Date().toISOString() });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("FantaElite backend avviato su porta", PORT));

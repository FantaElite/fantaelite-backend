import express from "express";
import crypto from "crypto";
import JSZip from "jszip";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { google } from "googleapis";

const app = express();
// Accetta JSON e anche form-urlencoded (Ko-fi può mandare form)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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

// === Normalizzatori e mapping ruoli ===
function toNum(v) {
  if (v == null || v === "") return 0;
  const s = String(v).trim();

  // Gestione locale:
  // "1.234,56" -> it    (punti migliaia, virgola decimale)
  // "1,234.56" -> en    (virgola migliaia, punto decimale)
  // "6,75"     -> it
  // "6.75"     -> en
  // "375"      -> intero
  let t = s;
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) {        // 1.234,56
    t = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) { // 1,234.56
    t = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) { // 6,75
    t = s.replace(",", ".");
  } else { // 6.75 o 375 o "1,234"
    t = s.replace(/,/g, ""); // rimuovi virgole come migliaia
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}
function cleanStr(s){ return String(s || "").trim(); }

// Mappa ruoli scritti per esteso/variazioni → P/D/C/A
function mapRole(raw){
  const x = cleanStr(raw).toLowerCase();

  if (x === "p" || x.includes("port")) return "P"; // Portiere, Port., Por
  if (x === "d" || x.includes("dif")) return "D";  // Difensore, Dif., DC/DS/TD/TS
  if (x === "c" || x.includes("centro") || x.includes("med")) return "C"; // Centrocampista, Mediano
  if (x === "a" || x.includes("att") || x.includes("punta") || x.includes("ala") || x.includes("est")) return "A"; // Attaccante, Punta, Ala, Esterno

  // fallback con iniziale/parola
  if (/^port/.test(x)) return "P";
  if (/^dif/.test(x))  return "D";
  if (/^centro|^med/.test(x)) return "C";
  if (/^att|^punta|^ala|^est/.test(x)) return "A";

  return ""; // sconosciuto → scarto
}

// === Lettura robusta da Google Sheets (cache 10 min) ===
let CACHE = { at: 0, rows: [] };

async function readPlayers() {
  const now = Date.now();
  if (now - CACHE.at < 10 * 60 * 1000 && CACHE.rows.length) return CACHE.rows;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Database Fantacalcio!A:Z" // range largo, ordine colonne libero
  });

  const values = res.data.values || [];
  if (!values.length) { CACHE = { at: now, rows: [] }; return []; }

  const [header, ...data] = values;
  const H = header.map(h => cleanStr(h));
  const canon = H.map(h => h.toLowerCase());

  function findIdxBySynonyms(names) {
    for (const raw of names) {
      const name = raw.toLowerCase();
      // match esatto (con varianti spazi/underscore)
      let i = canon.findIndex(h =>
        h === name ||
        h === name.replace(/\s+/g,"_") ||
        h === name.replace(/\s+/g,"")
      );
      if (i >= 0) return i;
      // match parziale
      i = canon.findIndex(h => h.includes(name));
      if (i >= 0) return i;
    }
    return -1;
  }

  const idx = {
    Nome:         findIdxBySynonyms(["Nome","Giocatore","Player","Calciatore"]),
    Squadra:      findIdxBySynonyms(["Squadra","Team","Club"]),
    Ruolo:        findIdxBySynonyms(["Ruolo","Posizione","Role"]),
    Media_Voto:   findIdxBySynonyms(["Media_Voto","Media Voto","Media","MV"]),
    Fantamedia:   findIdxBySynonyms(["Fantamedia","Fanta Media","Fanta_media","FM"]),
    Quotazione:   findIdxBySynonyms(["Quotazione","Quot.","Quot","Prezzo","Crediti","Valore","Costo","Price","Cost","Val."]),
    Partite_Voto: findIdxBySynonyms(["Partite_Voto","Partite","Partite Voto","PV","Presenze","Giocate"])
  };

  // minimi indispensabili
  if (idx.Nome < 0 || idx.Ruolo < 0 || idx.Quotazione < 0) {
    throw new Error("Header mancanti: servono almeno Nome, Ruolo e (Quotazione/Prezzo/Crediti/Valore) nella riga 1 della linguetta 'Database Fantacalcio'.");
  }

  const rows = data.map(r => {
    const ruolo = mapRole(r[idx.Ruolo]);
    return {
      Nome: cleanStr(r[idx.Nome]),
      Squadra: idx.Squadra >= 0 ? cleanStr(r[idx.Squadra]) : "",
      Ruolo: ruolo,
      Media_Voto: idx.Media_Voto >= 0 ? toNum(r[idx.Media_Voto]) : 0,
      Fantamedia: idx.Fantamedia >= 0 ? toNum(r[idx.Fantamedia]) : 0,
      Quotazione: toNum(r[idx.Quotazione]),
      Partite_Voto: idx.Partite_Voto >= 0 ? toNum(r[idx.Partite_Voto]) : 0,
    };
  })
  .filter(x => x.Nome && ["P","D","C","A"].includes(x.Ruolo) && Number.isFinite(x.Quotazione));

  CACHE = { at: now, rows };
  return rows;
}

// === Config & util ===
const CFG = {
  budgetMin: 380,
  budgetMax: 500,        // alza a 520 se i tuoi dati sono “costosi”
  maxTries: 500,         // aumentato
  rolesCount: { P: 3, D: 8, C: 8, A: 6 },
  pct: {
    equilibrata: { P:[0.04,0.08], D:[0.08,0.14], C:[0.20,0.30], A:[0.56,0.64] },
    moddifesa:   { P:[0.08,0.10], D:[0.18,0.20], C:[0.30,0.32], A:[0.40,0.42] }
  }
};
function sum(arr){ return arr.reduce((s,p)=>s+(p.Quotazione||0),0); }
function hashSeed(s){ return [...Buffer.from(s)].reduce((a,b)=>((a<<5)-a+b)>>>0, 2166136261); }
function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }

// === Algoritmo con pool 120, tolleranza a scalini ===
function pickTeam(players, mode, seed = crypto.randomUUID(), budgetMin = CFG.budgetMin, budgetMax = CFG.budgetMax) {
  const rng = mulberry32(hashSeed(seed));
  const byRole = { P:[], D:[], C:[], A:[] };
  players.forEach(p => { if (byRole[p.Ruolo]) byRole[p.Ruolo].push(p); });

  // ordina per priorità: Partite_Voto, Fantamedia, Quotazione
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
      // pool ampliato a 120
      let pool = byRole[R].slice(0, Math.min(120, byRole[R].length));
      while (team[R].length < need && pool.length) {
        const i = Math.floor(rng()*pool.length);
        team[R].push(pool.splice(i,1)[0]);
      }
    });

    const flat = [...team.P, ...team.D, ...team.C, ...team.A];
    if (flat.length !== 25) continue;

    const total = flat.reduce((s,p)=>s+(p.Quotazione||0),0);
    if (total < budgetMin || total > budgetMax) continue;

    const pctSpent = {
      P: sum(team.P)/total, D: sum(team.D)/total,
      C: sum(team.C)/total, A: sum(team.A)/total
    };

    // controllo percentuali per ruolo con tolleranza a scalini
    const base = CFG.pct[mode];
    if (!base) throw new Error("Modalità non riconosciuta");
    const within = (r, tilt=0) => {
      const lo = Math.max(0, base[r][0] - tilt);
      const hi = Math.min(1, base[r][1] + tilt);
      return pctSpent[r] >= lo && pctSpent[r] <= hi;
    };

    const okStrict   = ["P","D","C","A"].every(r => within(r, 0));
    const okSoft02   = ["P","D","C","A"].every(r => within(r, 0.02));
    const okSoft05   = ["P","D","C","A"].every(r => within(r, 0.05));

    if (okStrict || okSoft02 || okSoft05) {
      return { team, total, pctSpent, seed };
    }
  }

  throw new Error("Impossibile generare la rosa entro i tentativi massimi");
}

// === Fallback: sempre una rosa valida (i più economici per ruolo) ===
function pickFallbackCheapest(players, seed = crypto.randomUUID()) {
  const byRole = { P:[], D:[], C:[], A:[] };
  players.forEach(p => { if (byRole[p.Ruolo]) byRole[p.Ruolo].push(p); });
  const need = { P:3, D:8, C:8, A:6 };

  for (const r of ["P","D","C","A"]) {
    byRole[r].sort((a,b) =>
      (a.Quotazione - b.Quotazione) ||
      (b.Fantamedia - a.Fantamedia) ||
      (b.Partite_Voto - a.Partite_Voto)
    );
    if (byRole[r].length < need[r]) throw new Error(`Dataset insufficiente per ruolo ${r}`);
  }

  const team = {
    P: byRole.P.slice(0, need.P),
    D: byRole.D.slice(0, need.D),
    C: byRole.C.slice(0, need.C),
    A: byRole.A.slice(0, need.A),
  };
  const total = [...team.P, ...team.D, ...team.C, ...team.A].reduce((s,p)=>s+(p.Quotazione||0),0);
  const pctSpent = {
    P: team.P.reduce((s,p)=>s+(p.Quotazione||0),0) / (total||1),
    D: team.D.reduce((s,p)=>s+(p.Quotazione||0),0) / (total||1),
    C: team.C.reduce((s,p)=>s+(p.Quotazione||0),0) / (total||1),
    A: team.A.reduce((s,p)=>s+(p.Quotazione||0),0) / (total||1),
  };
  return { team, total, pctSpent, seed, fallback: true };
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

// === Debug: cosa c'è nel dataset ===
app.get("/debug/dataset", async (req, res) => {
  try {
    const players = await readPlayers();
    const byR = { P:0, D:0, C:0, A:0 };
    players.forEach(p => { if (byR[p.Ruolo] != null) byR[p.Ruolo]++; });

    const prices = players.map(p => p.Quotazione || 0).filter(Number.isFinite).sort((a,b)=>a-b);
    const q = (k)=> prices.length ? prices[Math.floor(k*(prices.length-1))] : 0;

    res.json({
      count: players.length,
      byRole: byR,
      priceStats: { min: prices[0]||0, p25: q(0.25), median: q(0.5), p75: q(0.75), max: prices[prices.length-1]||0 },
      sample: players.slice(0, 5)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// 3 livelli: normale → budgetMax allargato → fallback cheapest
app.post("/api/test-generate", async (req,res)=>{
  try{
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return res.status(401).end();
    const { mode="equilibrata", email, budgetMin, budgetMax } = req.body || {};
    if (!email) return res.status(400).json({ error:"email richiesta" });

    const players = await readPlayers();
    const seed = crypto.randomUUID();

    const doOne = async (m) => {
      try {
        // 1° tentativo: vincoli normali (con eventuale budget custom dal body)
        const out = pickTeam(players, m, seed, budgetMin || CFG.budgetMin, budgetMax || CFG.budgetMax);
        const pdf = await renderPdf({ mode: m, payload: out });
        await sendEmail(email,
          `FantaElite — La tua rosa (${m==="equilibrata"?"Equilibrata":"Mod. Difesa"})`,
          "Grazie per l'acquisto! In allegato trovi il PDF della tua rosa.",
          [{ filename:`FantaElite_${m==="equilibrata"?"Equilibrata":"ModDifesa"}.pdf`, content: pdf }]
        );
      } catch {
        try {
          // 2° tentativo: allargo budget
          const out2 = pickTeam(players, m, seed, (budgetMin||CFG.budgetMin), Math.max(540, budgetMax||CFG.budgetMax));
          const pdf2 = await renderPdf({ mode: m, payload: out2 });
          await sendEmail(email,
            `FantaElite — La tua rosa (${m==="equilibrata"?"Equilibrata":"Mod. Difesa"})`,
            "Nota: vincoli allargati per garantire la generazione della rosa.",
            [{ filename:`FantaElite_${m==="equilibrata"?"Equilibrata":"ModDifesa"}.pdf`, content: pdf2 }]
          );
        } catch {
          // 3° tentativo: fallback cheapest
          const out3 = pickFallbackCheapest(players, seed);
          const pdf3 = await renderPdf({ mode: m, payload: out3 });
          await sendEmail(email,
            `FantaElite — La tua rosa (${m==="equilibrata"?"Equilibrata":"Mod. Difesa"})`,
            "Nota: generazione in modalità di sicurezza (rosa più economica per ruolo).",
            [{ filename:`FantaElite_${m==="equilibrata"?"Equilibrata":"ModDifesa"}.pdf`, content: pdf3 }]
          );
        }
      }
    };

    if (mode === "complete"){
      await doOne("equilibrata");
      await doOne("moddifesa");
      return res.json({ ok:true, note:"invio doppio effettuato (due email separate in test)" });
    } else {
      await doOne(mode);
      return res.json({ ok:true });
    }
  }catch(e){
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// === Webhook Ko-fi ===
app.post("/webhook/kofi", async (req, res) => {
  try {
    // Firma: per i primi test puoi lasciare vuoto KOFI_WEBHOOK_SECRET
    const provided = (req.headers["x-ko-fi-signature"] || req.headers["x-kofi-signature"] || "").toString();
    if (KOFI_WEBHOOK_SECRET && provided !== KOFI_WEBHOOK_SECRET) {
      return res.status(401).json({ ok:false, error:"Firma non valida" });
    }

    const ev = req.body || {};
    const email = (ev.email || ev.payer_email || ev.from || "").toString().trim().toLowerCase();
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
      let one, two;
      try {
        one = pickTeam(players, "equilibrata", seed);
      } catch {
        one = pickFallbackCheapest(players, seed);
      }
      try {
        // prova a generare una seconda rosa diversa
        for (let i=0;i<CFG.maxTries;i++){
          const tmp = pickTeam(players, "moddifesa", crypto.randomUUID());
          const overlap = new Set([...one.team.P, ...one.team.D, ...one.team.C, ...one.team.A].map(p=>p.Nome));
          const twoFlat = [...tmp.team.P,...tmp.team.D,...tmp.team.C,...tmp.team.A].map(p=>p.Nome);
          const inter = twoFlat.filter(n=>overlap.has(n)).length;
          const uniq = 25;
          if (inter/uniq <= 0.4) { two = tmp; break; }
        }
        if (!two) two = pickTeam(players, "moddifesa", crypto.randomUUID(), CFG.budgetMin, Math.max(540, CFG.budgetMax));
      } catch {
        two = pickFallbackCheapest(players, crypto.randomUUID());
      }

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
      let out;
      try {
        out = pickTeam(players, mode, seed);
      } catch {
        try {
          out = pickTeam(players, mode, seed, CFG.budgetMin, Math.max(540, CFG.budgetMax));
        } catch {
          out = pickFallbackCheapest(players, seed);
        }
      }
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

// === Avvio server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("FantaElite backend avviato su porta", PORT));

// server.js (ESM) — Backend FantaElite
// Avvio con:  node --env-file=.env server.js
// Dipendenze: npm i express morgan pdfkit uuid

import express from 'express';
import morgan from 'morgan';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';

// =========================
// ENV & CONFIG
// =========================
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'abc123!fantaElite2025';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''; // es: proj_xxxxx

const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL     = process.env.FROM_EMAIL || 'FantaElite <no-reply@fantaelite.local>';

// =========================
// APP
// =========================
const app = express();
app.use(morgan('dev'));
app.use(express.json());

// =========================
/** LOG CHIARI ALL’AVVIO */
// =========================
const aiOn = !!OPENAI_API_KEY;
console.log(`🧠 Modalità AI: ${aiOn
  ? `OPENAI (${OPENAI_MODEL}${OPENAI_PROJECT ? `, project: ${OPENAI_PROJECT}` : ''})`
  : 'FALLBACK STATICO'}`);

if (!KOFI_VERIFICATION_TOKEN) {
  console.warn('⚠️  KOFI_VERIFICATION_TOKEN mancante: configura il webhook su Ko-fi.');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY mancante: verrà usato il roster di fallback statico.');
}

// =========================
// UTIL
// =========================
function requireApiKey(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function fallbackRoster() {
  return [
    { ruolo: 'P', nome: 'Portiere Solidissimo', costo: 20 },
    { ruolo: 'D', nome: 'Terzino Motorino',    costo: 18 },
    { ruolo: 'D', nome: 'Centrale Aff

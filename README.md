# FantaElite Backend (Render.com)
Express + Google Sheets + pdfkit + Nodemailer.

## Avvio locale
1) `npm install`
2) Crea `.env` con le variabili (vedi sotto)
3) `npm start` → http://localhost:3000

## Variabili richieste
API_KEY=...
SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

MAIL_FROM="FantaElite <no-reply@esempio.it>"
MAIL_USER="tuo@gmail.com"
MAIL_PASS="app-password"   # password applicazione / provider SMTP
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="465"

# Ko-fi (per il primo test lasciare vuoto KOFI_WEBHOOK_SECRET)
KOFI_WEBHOOK_SECRET=
KOFI_API_KEY=

## Endpoints
POST /webhook/kofi         # riceve pagamento Ko-fi, genera e invia PDF/ZIP via email
POST /api/test-generate    # test interno (Authorization: Bearer API_KEY)

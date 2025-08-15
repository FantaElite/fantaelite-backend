const API_KEY = "abc123!fantaElite2025";
const EMAIL   = "la_tua_email@esempio.it";

fetch("https://fantaelite-backend.onrender.com/api/test-generate", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ mode: "equilibrata", email: EMAIL, budgetMin: 380, budgetMax: 520 })
})
.then(async (r) => {
  console.log("Status:", r.status);
  const txt = await r.text();
  try { console.log("Body:", JSON.parse(txt)); } catch { console.log("Body:", txt); }
})
.catch(console.error);

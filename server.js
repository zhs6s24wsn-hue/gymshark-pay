const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "gymshark";
const PRICE_STARS = Number(process.env.PRICE_STARS || 150);
const DAYS = 30;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан!");
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: {}, events: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch {}
let flushT = null;
function flush() {
  clearTimeout(flushT);
  flushT = setTimeout(() => {
    try { const t = DB_FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); } catch (e) {}
  }, 150);
}
const U = id => (db.users[id] ||= { id: Number(id), subUntil: 0, remind: true, tips: [], charges: [], log: [], notified: false });

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return r.json();
}

function auth(initData) {
  const p = new URLSearchParams(initData || "");
  const hash = p.get("hash"); p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const mine = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (!hash || mine !== hash) throw new Error("bad hash");
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) throw new Error("stale");
  return JSON.parse(p.get("user")).id;
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "Content-Type,X-Admin-Key"); if (req.method === "OPTIONS") return res.end(); next(); });

app.get("/", (_, res) => res.json({ ok: true, service: "gymshark-stars", price: PRICE_STARS, botSet: !!BOT_TOKEN }));

// 1. Создание счёта на звёзды
app.post("/api/invoice", async (req, res) => {
  try {
    const uid = auth(req.body.initData);
    const kind = req.body.kind === "tip" ? "tip" : "sub";
    const stars = kind === "sub" ? PRICE_STARS : Math.round(Number(req.body.stars));
    if (!(stars >= 1 && stars <= 100000)) return res.status(400).json({ error: "Неверная сумма" });

    const r = await tg("createInvoiceLink", {
      title: kind === "sub" ? `GymShark PRO · ${DAYS} дней` : `Поддержка автора · ${stars} ⭐`,
      description: kind === "sub" ? "Безлимитные тренировки, графики, облако. Возвратов нет." : "Спасибо! Звёзды идут на серверы и обновления GymShark.",
      payload: JSON.stringify({ uid, kind, stars, days: DAYS }),
      provider_token: "", currency: "XTR",
      prices: [{ label: kind === "sub" ? `PRO · ${DAYS} дней` : "Донат", amount: stars }]
    });
    if (!r.ok) return res.status(500).json({ error: r.description });
    U(uid); flush();
    res.json({ link: r.result });
  } catch (e) { res.status(403).json({ error: "auth" }); }
});

// 2. Проверка статуса подписки
app.post("/api/status", (req, res) => {
  try { const u = U(auth(req.body.initData)); res.json({ subUntil: u.subUntil, remind: u.remind !== false, tips: u.tips.length }); }
  catch { res.status(403).json({ subUntil: 0 }); }
});

app.post("/api/remind", (req, res) => {
  try { const u = U(auth(req.body.initData)); u.remind = !!req.body.on; flush(); res.json({ ok: true, remind: u.remind }); }
  catch { res.status(403).json({ ok: false }); }
});

// 3. Webhook от Telegram (когда оплата прошла)
app.post("/webhook", async (req, res) => {
  const up = req.body || {};
  if (up.pre_checkout_query) await tg("answerPreCheckoutQuery", { pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
  
  const sp = up.message && up.message.successful_payment;
  if (sp && sp.currency === "XTR") {
    let pay = {}; try { pay = JSON.parse(sp.invoice_payload); } catch {}
    if (pay.uid) {
      const u = U(pay.uid);
      if (!u.charges.some(c => c.id === sp.telegram_payment_charge_id)) {
        const rec = { id: sp.telegram_payment_charge_id, t: Date.now(), kind: pay.kind === "tip" ? "tip" : "sub", stars: sp.total_amount };
        u.charges.push(rec);
        db.events.push(Object.assign({ uid: Number(pay.uid) }, rec));
        
        if (rec.kind === "sub") {
          u.subUntil = Math.max(Date.now(), u.subUntil) + (pay.days || DAYS) * 864e5;
          u.remind = true; u.notified = false;
          u.log.push({ t: Date.now(), type: "sub", days: pay.days || DAYS });
          await tg("sendMessage", { chat_id: pay.uid, text: `🦈 PRO активирован на ${pay.days || DAYS} дней!\n\nОплата: ${sp.total_amount} ⭐. Возвратов нет.` });
        } else {
          u.tips.push({ t: Date.now(), stars: sp.total_amount });
          u.log.push({ t: Date.now(), type: "tip", stars: sp.total_amount });
          await tg("sendMessage", { chat_id: pay.uid, text: `Спасибо за ${sp.total_amount} ⭐! 🦈` });
        }
        flush();
      }
    }
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GymShark Stars server started on port ${PORT}`));

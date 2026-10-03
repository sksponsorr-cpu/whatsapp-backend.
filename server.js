import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import pino from "pino";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  BACKEND_API_KEY,
  SESSIONS_DIR = "/data/sessions",
  PORT = 3000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BACKEND_API_KEY) {
  throw new Error("Variables manquantes : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKEND_API_KEY");
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: "warn" });
const sockets = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function update(userId, patch) {
  const { error } = await db.from("whatsapp_connections").update(patch).eq("user_id", userId);
  if (error) console.error("[db]", userId, error.message);
}

async function startSession(userId) {
  const dir = path.join(SESSIONS_DIR, userId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ["WhatsApp AI", "Chrome", "1.0.0"],
  });
  sockets.set(userId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // Nouveau QR (renouvelé toutes les ~20 s tant qu'il n'est pas scanné)
    if (qr) {
      await update(userId, {
        status: "pending",
        qr_code: qr,
        qr_updated_at: new Date().toISOString(),
      });
    }

    // QR scanné, session ouverte
    if (connection === "open") {
      const phone = sock.user.id.split("@")[0].split(":")[0];
      await update(userId, {
        status: "connected",
        phone_number: phone,
        qr_code: null,
        qr_updated_at: null,
        connected_at: new Date().toISOString(),
      });
    }

    if (connection === "close") {
      if (sockets.get(userId) !== sock) return; // session remplacée volontairement
      sockets.delete(userId);

      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(dir, { recursive: true, force: true });
        await update(userId, { status: "disconnected", qr_code: null, qr_updated_at: null });
      } else {
        // Inclut le redémarrage normal imposé par WhatsApp juste après le scan
        setTimeout(() => startSession(userId).catch(console.error), 2000);
      }
    }
  });
}

// Repart de zéro : supprime l'ancienne session et force un nouveau QR
async function freshSession(userId) {
  const old = sockets.get(userId);
  sockets.delete(userId);
  try { old?.end(undefined); } catch { /* ignore */ }
  fs.rmSync(path.join(SESSIONS_DIR, userId), { recursive: true, force: true });
  await startSession(userId);
}

const safeEqual = (a = "", b = "") => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sockets.size }));

app.post("/sessions/start", async (req, res) => {
  if (!safeEqual(req.get("x-api-key"), BACKEND_API_KEY)) return res.status(401).json({ error: "unauthorized" });
  const userId = req.body?.session_id;
  if (!UUID.test(userId ?? "")) return res.status(400).json({ error: "invalid_session_id" });

  try {
    await freshSession(userId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "start_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend WhatsApp sur :${PORT}`);
  // Reprise des sessions existantes après un redémarrage
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const id of fs.readdirSync(SESSIONS_DIR)) {
      if (UUID.test(id)) startSession(id).catch(console.error);
    }
  }
});

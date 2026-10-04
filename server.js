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
import { generateReply } from "./ai-reply.js";

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
const sockets = new Map(); // key: agentId → socket
const histories = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function updateSession(agentId, patch) {
  const { error } = await db
    .from("whatsapp_connections")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId);
  if (error) console.error("[db]", agentId, error.message);
}

function getHistory(key) {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key);
}

async function getAgentConfig(agentId) {
  try {
    const { data } = await db
      .from("agents")
      .select("model, tone, prompt, instructions, name")
      .eq("id", agentId)
      .maybeSingle();
    return data || {};
  } catch (e) {
    console.error("[getAgentConfig]", e);
    return {};
  }
}

async function saveMessage(agentId, from, text, reply, pushName) {
  try {
    const contactPhone = from.split("@")[0];

    const { data: existing } = await db
      .from("conversations")
      .select("id")
      .eq("user_id", agentId)
      .eq("contact_phone", contactPhone)
      .maybeSingle();

    let conversationId = existing?.id;

    if (!conversationId) {
      const { data: created } = await db
        .from("conversations")
        .insert({
          user_id: agentId,
          contact_phone: contactPhone,
          contact_name: pushName || contactPhone,
          last_message: reply,
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      conversationId = created?.id;
    } else {
      await db
        .from("conversations")
        .update({ last_message: reply, last_message_at: new Date().toISOString() })
        .eq("id", conversationId);
    }

    if (conversationId) {
      await db.from("messages").insert([
        { conversation_id: conversationId, user_id: agentId, role: "user", content: text },
        { conversation_id: conversationId, user_id: agentId, role: "assistant", content: reply },
      ]);
    }
  } catch (e) {
    console.error("[saveMessage]", e);
  }
}

async function startSession(agentId) {
  const dir = path.join(SESSIONS_DIR, agentId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ["Chatplay", "Chrome", "1.0.0"],
  });
  sockets.set(agentId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      await updateSession(agentId, {
        status: "pending",
        qr_code: qr,
        qr_updated_at: new Date().toISOString(),
      });
    }

    if (connection === "open") {
      const phone = sock.user.id.split("@")[0].split(":")[0];
      await updateSession(agentId, {
        status: "connected",
        phone_number: phone,
        qr_code: null,
        qr_updated_at: null,
        connected_at: new Date().toISOString(),
      });
    }

    if (connection === "close") {
      if (sockets.get(agentId) !== sock) return;
      sockets.delete(agentId);

      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(dir, { recursive: true, force: true });
        await updateSession(agentId, { status: "disconnected", qr_code: null });
      } else {
        setTimeout(() => startSession(agentId).catch(console.error), 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || from.endsWith("@g.us") || from === "status@broadcast") continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          null;
        if (!text) continue;

        await sock.readMessages([msg.key]);
        await sock.sendPresenceUpdate("composing", from);

        // Charge la config de l'agent à chaque message
        const cfg = await getAgentConfig(agentId);

        const history = getHistory(`${agentId}:${from}`);
        const reply = await generateReply(text, history, {
          model: cfg.model || "gemini-2.0-flash",
          systemPrompt: cfg.prompt || cfg.instructions || undefined,
        });

        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        if (history.length > 20) history.splice(0, history.length - 20);

        await sock.sendMessage(from, { text: reply });
        await saveMessage(agentId, from, text, reply, msg.pushName);
      } catch (e) {
        console.error("[message_handler]", agentId, e);
      }
    }
  });
}

async function freshSession(agentId) {
  const old = sockets.get(agentId);
  sockets.delete(agentId);
  try { old?.end(undefined); } catch { /* ignore */ }
  fs.rmSync(path.join(SESSIONS_DIR, agentId), { recursive: true, force: true });
  await startSession(agentId);
}

const safeEqual = (a = "", b = "") => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sockets.size }));

app.post("/test-message", async (req, res) => {
  if (!safeEqual(req.get("x-api-key"), BACKEND_API_KEY)) return res.status(401).json({ error: "unauthorized" });
  const { message, model, system_prompt } = req.body || {};
  if (!message || typeof message !== "string") return res.status(400).json({ error: "message_required" });

  try {
    const { generateReply } = await import("./ai-reply.js");
    const reply = await generateReply(message, [], { model, systemPrompt: system_prompt });
    res.json({ reply });
  } catch (e) {
    console.error("[test-message]", e);
    res.status(500).json({ error: "generation_failed" });
  }
});

app.post("/sessions/start", async (req, res) => {
  if (!safeEqual(req.get("x-api-key"), BACKEND_API_KEY)) return res.status(401).json({ error: "unauthorized" });
  const agentId = req.body?.session_id;
  if (!UUID.test(agentId ?? "")) return res.status(400).json({ error: "invalid_agent_id" });

  try {
    await freshSession(agentId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "start_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend WhatsApp sur :${PORT}`);
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const id of fs.readdirSync(SESSIONS_DIR)) {
      if (UUID.test(id)) startSession(id).catch(console.error);
    }
  }
});

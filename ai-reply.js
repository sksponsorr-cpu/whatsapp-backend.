// Génère la réponse de l'agent IA.
// Modèle gratuit par défaut : gemini-2.0-flash (Google)
// Le backend peut être appelé avec un modèle ou un prompt personnalisé.

const GEMINI_KEY = process.env.GEMINI_KEY;
const FAL_KEY = process.env.FAL_KEY;
const DEFAULT_MODEL = process.env.AI_MODEL || "gemini-2.0-flash";

const GEMINI_ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const FAL_ENDPOINT = "https://fal.run/openrouter/router/openai/v1/chat/completions";

const DEFAULT_SYSTEM_PROMPT =
  "Tu es un agent WhatsApp poli et concis. Tu réponds en français, sauf si le client écrit dans une autre langue. Réponses courtes, utiles, naturelles, sans markdown.";

export async function generateReply(userText, history = [], options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // Si le modèle commence par "gemini" → utilise Google Gemini (gratuit)
  if (model.startsWith("gemini")) {
    if (!GEMINI_KEY) {
      console.error("GEMINI_KEY manquante");
      return "Désolé, une erreur technique m'empêche de répondre pour le moment.";
    }
    return callGemini(userText, history, systemPrompt, model);
  }

  // Sinon → fal.ai (GPT, Claude, etc.)
  if (!FAL_KEY) {
    console.error("FAL_KEY manquante");
    return "Désolé, une erreur technique m'empêche de répondre pour le moment.";
  }
  return callFal(userText, history, systemPrompt, model);
}

async function callGemini(userText, history, systemPrompt, model) {
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userText }] },
  ];

  try {
    const res = await fetch(GEMINI_ENDPOINT(model, GEMINI_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 400, temperature: 0.6 },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.error("gemini_error", res.status, await res.text());
      return "Désolé, je n'ai pas pu générer de réponse pour le moment.";
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Désolé, je n'ai pas compris.";
  } catch (e) {
    console.error("gemini_exception", e);
    return "Désolé, une erreur est survenue, réessayez dans un instant.";
  }
}

async function callFal(userText, history, systemPrompt, model) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  try {
    const res = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${FAL_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 400,
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.error("fal_error", res.status, await res.text());
      return "Désolé, je n'ai pas pu générer de réponse pour le moment.";
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "Désolé, je n'ai pas compris.";
  } catch (e) {
    console.error("fal_exception", e);
    return "Désolé, une erreur est survenue, réessayez dans un instant.";
  }
}

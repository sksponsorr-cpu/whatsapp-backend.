// Génère la réponse de l'agent IA via fal.ai (accès à GPT, Gemini, Claude… avec une seule clé).
// Variables Railway : FAL_KEY (obligatoire), AI_MODEL (optionnel).

const FAL_KEY = process.env.FAL_KEY;
const AI_MODEL = process.env.AI_MODEL || "google/gemini-2.5-flash";
const ENDPOINT = "https://fal.run/openrouter/router/openai/v1/chat/completions";

const SYSTEM_PROMPT =
  "Tu es un agent WhatsApp poli et concis. Tu réponds en français, sauf si le client écrit dans une autre langue. " +
  "Réponses courtes, utiles, naturelles, sans markdown.";

export async function generateReply(userText, history = []) {
  if (!FAL_KEY) {
    console.error("FAL_KEY manquante");
    return "Désolé, une erreur technique m'empêche de répondre pour le moment.";
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${FAL_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: 400,
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(25_000),
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

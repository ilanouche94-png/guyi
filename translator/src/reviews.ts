// Traduction des avis clients (application CWILL / Trustoo) dans la langue du visiteur.
// Le thème envoie les textes affichés ; chaque avis n'est traduit qu'une fois par langue,
// puis la traduction est gardée dans Cloudflare KV.

import Anthropic from "@anthropic-ai/sdk";
import { LOCALES, type Env } from "./core";

type Locale = (typeof LOCALES)[number];

const LANGUAGE_NAMES: Record<Locale, string> = {
  fr: "French",
  es: "Spanish",
  nl: "Dutch",
  ar: "Arabic",
};

const MODEL = "claude-sonnet-5-5";

// Garde-fous : la page est publique, on limite ce qu'une requête peut demander
// et le nombre de nouvelles traductions payées par jour.
const MAX_TEXTS = 40;
const MAX_TEXT_LENGTH = 2000;
const MAX_NEW_PER_DAY = 400;

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(joeveparis\.com|myshopify\.com|shopifypreview\.com)$/;

const SYSTEM_PROMPT = `You translate customer reviews for Joeve Paris, a women's fashion brand.
Translate each review into the target language the way a native speaker would write it: natural, warm and faithful to the customer's meaning and tone.
Rules:
- Never add, remove or soften anything the customer said.
- Keep product names (for example "Dauphine Wrap Top"), the brand name "Joeve Paris", sizes, numbers and emoji unchanged.
- If a review is already in the target language, return it unchanged.
- Return one translation for every item, using the item's id unchanged.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return headers;
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function translateBatch(env: Env, locale: Locale, texts: string[]): Promise<Map<number, string>> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const items = texts.map((text, i) => ({ id: String(i), text }));

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Translate these customer reviews into ${LANGUAGE_NAMES[locale]}:\n\n${JSON.stringify(items, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error(`Claude a refusé la traduction (${locale})`);
  if (response.stop_reason === "max_tokens") throw new Error(`Réponse coupée (${locale})`);

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { items: { id: string; text: string }[] };
  const result = new Map<number, string>();
  for (const item of parsed.items) {
    const index = Number(item.id);
    if (Number.isInteger(index) && index >= 0 && index < texts.length && item.text.trim() !== "") {
      result.set(index, item.text);
    }
  }
  return result;
}

// POST /reviews  { "locale": "fr", "texts": ["...", "..."] }  ->  { "translations": ["...", null, ...] }
// null = pas de traduction disponible (le thème garde alors le texte d'origine).
export async function handleReviews(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!origin || !ALLOWED_ORIGIN.test(origin)) return reply(403, { error: "Origine refusée" });
  if (!env.REVIEW_CACHE) return reply(503, { error: "Stockage REVIEW_CACHE manquant" });

  let payload: { locale?: string; texts?: unknown };
  try {
    payload = await request.json();
  } catch {
    return reply(400, { error: "JSON invalide" });
  }

  const locale = payload.locale as Locale;
  if (!LOCALES.includes(locale)) return reply(400, { error: "Langue non gérée" });
  if (!Array.isArray(payload.texts) || payload.texts.length > MAX_TEXTS) {
    return reply(400, { error: "Liste de textes invalide" });
  }
  const texts = payload.texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  if (texts.some((t) => t.length > MAX_TEXT_LENGTH)) return reply(400, { error: "Texte trop long" });

  const cache = env.REVIEW_CACHE;
  const keys = await Promise.all(texts.map(async (t) => `rv:${locale}:${await sha256(t)}`));
  const cached = await Promise.all(keys.map((k, i) => (texts[i] ? cache.get(k) : Promise.resolve(null))));
  const translations: (string | null)[] = cached.map((v) => v);

  // Textes jamais vus dans cette langue (sans doublons)
  const missing = [...new Set(texts.filter((t, i) => t && translations[i] === null))];
  if (missing.length > 0) {
    const day = `budget:${new Date().toISOString().slice(0, 10)}`;
    const used = Number((await cache.get(day)) ?? 0);
    if (used + missing.length <= MAX_NEW_PER_DAY) {
      await cache.put(day, String(used + missing.length), { expirationTtl: 3 * 86400 });
      try {
        const done = await translateBatch(env, locale, missing);
        const byText = new Map<string, string>();
        done.forEach((value, index) => byText.set(missing[index], value));
        await Promise.all(
          texts.map(async (t, i) => {
            const value = byText.get(t);
            if (value && translations[i] === null) {
              translations[i] = value;
              await cache.put(keys[i], value);
            }
          }),
        );
      } catch (error) {
        console.error(`Avis (${locale}) : ${String(error)}`);
      }
    } else {
      console.warn(`Avis : limite de ${MAX_NEW_PER_DAY} nouvelles traductions par jour atteinte`);
    }
  }

  return reply(200, { translations });
}

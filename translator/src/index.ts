// Cloudflare Worker : reçoit les webhooks Shopify "products/create" et "products/update"
// et lance la traduction automatique du produit en tâche de fond.

import { translateProduct, type Env } from "./core";
import { handleReviews } from "./reviews";

async function validHmac(body: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body));
}

export default {
  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    // Adresse de la boutique par défaut (pour un Worker créé directement dans le site Cloudflare).
    const env: Env = { ...rawEnv, SHOP_DOMAIN: rawEnv.SHOP_DOMAIN || "q0uptb-wj.myshopify.com" };

    // Traduction des avis clients, appelée depuis le thème
    if (new URL(request.url).pathname === "/reviews") return handleReviews(request, env);

    if (request.method !== "POST") {
      // Page de contrôle : indique quels réglages sont en place (sans jamais afficher leur valeur).
      const check = (value?: string) => (value ? "OK" : "MANQUANT");
      return new Response(
        [
          "Joeve translator",
          `ANTHROPIC_API_KEY : ${check(env.ANTHROPIC_API_KEY)}`,
          `SHOPIFY_CLIENT_ID : ${check(env.SHOPIFY_CLIENT_ID || env.SHOPIFY_ADMIN_TOKEN)}`,
          `SHOPIFY_CLIENT_SECRET : ${check(env.SHOPIFY_CLIENT_SECRET || env.SHOPIFY_ADMIN_TOKEN)}`,
          `SHOPIFY_WEBHOOK_SECRET : ${check(env.SHOPIFY_WEBHOOK_SECRET)}`,
          `REVIEW_CACHE (stockage KV des avis) : ${env.REVIEW_CACHE ? "OK" : "MANQUANT"}`,
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    const body = await request.text();
    const secret = env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret || !(await validHmac(body, request.headers.get("X-Shopify-Hmac-Sha256"), secret))) {
      return new Response("Signature invalide", { status: 401 });
    }

    const topic = request.headers.get("X-Shopify-Topic");
    if (topic !== "products/create" && topic !== "products/update") {
      return new Response("Ignoré", { status: 200 });
    }

    let productId: number | undefined;
    try {
      productId = (JSON.parse(body) as { id?: number }).id;
    } catch {
      return new Response("JSON invalide", { status: 400 });
    }
    if (!productId) return new Response("Pas d'id produit", { status: 400 });

    // Shopify attend une réponse en moins de 5 s : on répond tout de suite
    // et on traduit ensuite.
    ctx.waitUntil(
      translateProduct(env, productId)
        .then((report) => console.log(JSON.stringify({ productId, ...report })))
        .catch((error) => console.error(`Produit ${productId} : ${String(error)}`)),
    );
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

// Cloudflare Worker : reçoit les webhooks Shopify "products/create" et "products/update"
// et lance la traduction automatique du produit en tâche de fond.

import { translateProduct, type Env } from "./core";

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Joeve translator OK", { status: 200 });
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

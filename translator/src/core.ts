// Traduction automatique des produits Joeve Paris : Shopify -> Claude -> Shopify.
// Utilisé par le Worker (webhook) et par le script de rattrapage (backfill.ts).

import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  SHOP_DOMAIN: string; // ex. "joeveparis.myshopify.com"
  ANTHROPIC_API_KEY: string;
  // Soit un jeton fixe (shpat_...), soit l'identifiant + le secret de l'app du Dev Dashboard.
  SHOPIFY_ADMIN_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  // Stockage Cloudflare KV qui garde les traductions des avis (une fois par avis et par langue).
  REVIEW_CACHE?: KVNamespace;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

// Les apps du Dev Dashboard obtiennent un jeton temporaire (24 h) avec leur identifiant et leur secret.
async function adminToken(env: Env): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error("Accès Shopify manquant : SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET");
  }
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) {
    throw new Error(`Jeton Shopify refusé (${res.status}) : ${JSON.stringify(json)}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000 };
  return cachedToken.value;
}

export const LOCALES = ["fr", "es", "nl", "ar"] as const;
type Locale = (typeof LOCALES)[number];

const LANGUAGE_NAMES: Record<Locale, string> = {
  fr: "French",
  es: "Spanish",
  nl: "Dutch",
  ar: "Arabic",
};

const MODEL = "claude-sonnet-5-5";
const API_VERSION = "2026-10";

// Champs du produit à traduire (on ignore l'URL "handle" et le type interne).
const PRODUCT_KEYS = new Set(["title", "body_html", "meta_title", "meta_description"]);

// Valeurs d'options qui ne se traduisent pas (tailles, nombres).
const UNTRANSLATABLE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d+([.,]\d+)?\s?(cm|mm|ml)?|one size|os)$/i;

interface ContentItem {
  key: string;
  value: string;
  digest: string;
}

interface Resource {
  id: string;
  content: ContentItem[];
  translations: Record<Locale, Map<string, { value: string; outdated: boolean }>>;
}

// Un champ à traduire : la ressource, la clé, le texte anglais et son empreinte.
interface Job {
  resourceId: string;
  key: string;
  value: string;
  digest: string;
}

export async function shopify<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await adminToken(env);
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors || !json.data) {
    throw new Error(`Shopify ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

const PRODUCT_QUERY = `
query ($id: ID!) {
  product(id: $id) {
    status
    onlineStoreUrl
    options { id optionValues { id } }
  }
}`;

const RESOURCES_QUERY = `
query ($ids: [ID!]!) {
  translatableResourcesByIds(resourceIds: $ids, first: 250) {
    nodes {
      resourceId
      translatableContent { key value digest }
      fr: translations(locale: "fr") { key value outdated }
      es: translations(locale: "es") { key value outdated }
      nl: translations(locale: "nl") { key value outdated }
      ar: translations(locale: "ar") { key value outdated }
    }
  }
}`;

const REGISTER_MUTATION = `
mutation ($id: ID!, $t: [TranslationInput!]!) {
  translationsRegister(resourceId: $id, translations: $t) {
    userErrors { field message }
  }
}`;

type RawTranslation = { key: string; value: string | null; outdated: boolean };
type RawNode = {
  resourceId: string;
  translatableContent: { key: string; value: string | null; digest: string | null }[];
} & Record<Locale, RawTranslation[]>;

async function loadResources(env: Env, productGid: string): Promise<Resource[] | null> {
  const { product } = await shopify<{
    product: {
      status: string;
      onlineStoreUrl: string | null;
      options: { id: string; optionValues: { id: string }[] }[];
    } | null;
  }>(env, PRODUCT_QUERY, { id: productGid });

  // On ne traduit qu'au moment où le produit est visible sur la boutique en ligne
  // (actif + publié) : avant, la fiche est encore en cours d'écriture.
  if (!product || product.status !== "ACTIVE" || !product.onlineStoreUrl) return null;

  const ids = [productGid];
  for (const option of product.options) {
    ids.push(option.id, ...option.optionValues.map((v) => v.id));
  }

  const { translatableResourcesByIds } = await shopify<{
    translatableResourcesByIds: { nodes: RawNode[] };
  }>(env, RESOURCES_QUERY, { ids });

  return translatableResourcesByIds.nodes.map((node) => {
    const isProduct = node.resourceId === productGid;
    const content = node.translatableContent
      .filter((c) => c.value && c.digest && c.value.trim() !== "")
      .filter((c) => (isProduct ? PRODUCT_KEYS.has(c.key) : c.key === "name"))
      .filter((c) => isProduct || !UNTRANSLATABLE.test(c.value!.trim()))
      .map((c) => ({ key: c.key, value: c.value!, digest: c.digest! }));

    const translations = {} as Resource["translations"];
    for (const locale of LOCALES) {
      translations[locale] = new Map(
        (node[locale] ?? []).map((t) => [t.key, { value: t.value ?? "", outdated: t.outdated }]),
      );
    }
    return { id: node.resourceId, content, translations };
  });
}

// Ce qui manque ou est périmé, langue par langue.
function missingJobs(resources: Resource[], locale: Locale): Job[] {
  const jobs: Job[] = [];
  for (const r of resources) {
    for (const c of r.content) {
      const existing = r.translations[locale].get(c.key);
      if (!existing || existing.outdated || existing.value.trim() === "") {
        jobs.push({ resourceId: r.id, key: c.key, value: c.value, digest: c.digest });
      }
    }
  }
  return jobs;
}

const SYSTEM_PROMPT = `You translate product content for Joeve Paris, a Parisian women's fashion brand.
Write the way a native-speaking fashion copywriter would: natural, elegant and concise, never word-for-word.
Rules:
- Keep all HTML tags, attributes, line breaks and emoji exactly as in the source; translate only the visible text.
- Never translate the brand name "Joeve Paris", size codes (XS, S, M, L, XL...), measurements, or product codes.
- Keep the same tone and roughly the same length as the source.
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

async function translate(client: Anthropic, locale: Locale, jobs: Job[]): Promise<Map<number, string>> {
  const items = jobs.map((job, i) => ({ id: String(i), field: job.key, text: job.value }));

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
        content: `Translate these items from English to ${LANGUAGE_NAMES[locale]}:\n\n${JSON.stringify(items, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude a refusé la traduction (${locale})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Réponse coupée (${locale}) : texte trop long`);
  }

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { items: { id: string; text: string }[] };
  const result = new Map<number, string>();
  for (const item of parsed.items) {
    const index = Number(item.id);
    if (Number.isInteger(index) && index >= 0 && index < jobs.length && item.text.trim() !== "") {
      result.set(index, item.text);
    }
  }
  return result;
}

export interface Report {
  skipped?: string;
  translated: Partial<Record<Locale, number>>;
  errors: string[];
}

// Traduit tout ce qui manque pour un produit. Sans effet si tout est déjà à jour.
export async function translateProduct(env: Env, productId: string | number): Promise<Report> {
  const productGid = String(productId).startsWith("gid://")
    ? String(productId)
    : `gid://shopify/Product/${productId}`;

  const report: Report = { translated: {}, errors: [] };
  const resources = await loadResources(env, productGid);
  if (!resources) {
    report.skipped = "produit non publié";
    return report;
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Les 4 langues en parallèle pour rester rapide.
  const results = await Promise.allSettled(
    LOCALES.map(async (locale) => {
      const jobs = missingJobs(resources, locale);
      if (jobs.length === 0) return { locale, jobs, texts: new Map<number, string>() };
      return { locale, jobs, texts: await translate(client, locale, jobs) };
    }),
  );

  // Regroupe par ressource : un seul enregistrement Shopify par ressource, toutes langues confondues.
  const byResource = new Map<string, { key: string; value: string; locale: string; translatableContentDigest: string }[]>();
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      report.errors.push(`${LOCALES[i]}: ${String(result.reason)}`);
      return;
    }
    const { locale, jobs, texts } = result.value;
    texts.forEach((value, index) => {
      const job = jobs[index];
      const list = byResource.get(job.resourceId) ?? [];
      list.push({ key: job.key, value, locale, translatableContentDigest: job.digest });
      byResource.set(job.resourceId, list);
    });
    if (texts.size > 0) report.translated[locale] = texts.size;
  });

  for (const [resourceId, translations] of byResource) {
    const { translationsRegister } = await shopify<{
      translationsRegister: { userErrors: { field: string[]; message: string }[] };
    }>(env, REGISTER_MUTATION, { id: resourceId, t: translations });
    for (const e of translationsRegister.userErrors) {
      report.errors.push(`${resourceId}: ${e.message}`);
    }
  }

  return report;
}

// Rattrapage : traduit une fois tous les produits publiés qui ne le sont pas encore.
// Usage : SHOP_DOMAIN=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... ANTHROPIC_API_KEY=... npm run backfill

import { shopify, translateProduct, type Env } from "./src/core";

const env: Env = {
  SHOP_DOMAIN: process.env.SHOP_DOMAIN ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  SHOPIFY_ADMIN_TOKEN: process.env.SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
};
if (!env.SHOP_DOMAIN || !env.ANTHROPIC_API_KEY) throw new Error("Variables manquantes : SHOP_DOMAIN, ANTHROPIC_API_KEY");

const LIST_QUERY = `
query ($after: String) {
  products(first: 50, after: $after, query: "status:active") {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}`;

let after: string | null = null;
let count = 0;
do {
  type Page = {
    products: {
      nodes: { id: string; title: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
  };
  const page: Page = await shopify<Page>(env, LIST_QUERY, { after: after as string | null });
  const nodes: Page["products"]["nodes"] = page.products.nodes;
  const pageInfo: Page["products"]["pageInfo"] = page.products.pageInfo;
  for (const product of nodes) {
    const report = await translateProduct(env, product.id);
    count++;
    console.log(`${count}. ${product.title}`, JSON.stringify(report));
  }
  after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
} while (after);

console.log(`Terminé : ${count} produits vérifiés.`);

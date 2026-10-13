// Rattrapage : traduit une fois tous les produits publiés qui ne le sont pas encore.
// Usage : SHOP_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... ANTHROPIC_API_KEY=... npm run backfill

import { translateProduct, type Env } from "./src/core";

const env: Env = {
  SHOP_DOMAIN: process.env.SHOP_DOMAIN ?? "",
  SHOPIFY_ADMIN_TOKEN: process.env.SHOPIFY_ADMIN_TOKEN ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};
for (const [name, value] of Object.entries(env)) {
  if (!value) throw new Error(`Variable manquante : ${name}`);
}

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
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query: LIST_QUERY, variables: { after } }),
  });
  const json = (await res.json()) as {
    data: {
      products: {
        nodes: { id: string; title: string }[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };
  };
  const { nodes, pageInfo } = json.data.products;
  for (const product of nodes) {
    const report = await translateProduct(env, product.id);
    count++;
    console.log(`${count}. ${product.title}`, JSON.stringify(report));
  }
  after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
} while (after);

console.log(`Terminé : ${count} produits vérifiés.`);

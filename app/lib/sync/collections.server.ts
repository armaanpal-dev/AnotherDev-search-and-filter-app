import prisma from "../../db.server";
import { gidId } from "./upsert.server";

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

/**
 * Sync collections and pages into the index so the storefront autocomplete can
 * show "Collections" and "Pages" sections (like the reference apps). These lists
 * are small, so a normal paginated query is fine (no bulk op needed).
 * Each part is resilient: a missing scope or error for one doesn't abort the other.
 */
export async function syncCollectionsAndPages(
  shopId: string,
  admin: AdminGraphql,
): Promise<{ collections: number; pages: number }> {
  const collections = await syncCollections(shopId, admin).catch((e) => {
    console.error("Collection sync failed:", e?.message);
    return 0;
  });
  const pages = await syncPages(shopId, admin).catch((e) => {
    console.error("Page sync failed (read_content scope?):", e?.message);
    return 0;
  });
  return { collections, pages };
}

async function syncCollections(shopId: string, admin: AdminGraphql): Promise<number> {
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const res = await admin.graphql(
      `#graphql
      query Collections($cursor: String) {
        collections(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              id handle title
              image { url }
              productsCount { count }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } },
    );
    const json = await res.json();
    const conn = json.data?.collections;
    if (!conn) break;
    for (const edge of conn.edges ?? []) {
      const n = edge.node;
      const collectionId = gidId(n.id);
      seen.push(collectionId);
      await prisma.collection.upsert({
        where: { shopId_collectionId: { shopId, collectionId } },
        create: {
          shopId, collectionId, handle: n.handle, title: n.title,
          imageUrl: n.image?.url ?? null, productCount: n.productsCount?.count ?? 0,
        },
        update: {
          handle: n.handle, title: n.title,
          imageUrl: n.image?.url ?? null, productCount: n.productsCount?.count ?? 0,
          indexedAt: new Date(),
        },
      });
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  // Drop collections that no longer exist.
  if (seen.length) {
    await prisma.collection.deleteMany({
      where: { shopId, collectionId: { notIn: seen } },
    });
  }
  return seen.length;
}

async function syncPages(shopId: string, admin: AdminGraphql): Promise<number> {
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const res = await admin.graphql(
      `#graphql
      query Pages($cursor: String) {
        pages(first: 100, after: $cursor) {
          edges { cursor node { id handle title } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } },
    );
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 200));
    const conn = json.data?.pages;
    if (!conn) break;
    for (const edge of conn.edges ?? []) {
      const n = edge.node;
      const pageId = gidId(n.id);
      seen.push(pageId);
      await prisma.page.upsert({
        where: { shopId_pageId: { shopId, pageId } },
        create: { shopId, pageId, handle: n.handle, title: n.title },
        update: { handle: n.handle, title: n.title, indexedAt: new Date() },
      });
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  if (seen.length) {
    await prisma.page.deleteMany({ where: { shopId, pageId: { notIn: seen } } });
  }
  return seen.length;
}

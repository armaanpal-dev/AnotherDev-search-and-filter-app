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
      await upsertCollectionRow(shopId, {
        collectionId,
        handle: n.handle,
        title: n.title,
        imageUrl: n.image?.url ?? null,
        productCount: n.productsCount?.count ?? 0,
      });
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  // Drop collections that no longer exist. Chunked: `notIn` sends one bind
  // parameter per id, and Postgres caps a statement at 65535 of them.
  if (seen.length) {
    await deleteMissing("collection", shopId, seen);
  }
  return seen.length;
}

export async function upsertCollectionRow(
  shopId: string,
  c: {
    collectionId: string;
    handle: string;
    title: string;
    imageUrl: string | null;
    productCount: number;
  },
) {
  await prisma.collection.upsert({
    where: { shopId_collectionId: { shopId, collectionId: c.collectionId } },
    create: {
      shopId,
      collectionId: c.collectionId,
      handle: c.handle,
      title: c.title,
      imageUrl: c.imageUrl,
      productCount: c.productCount,
    },
    update: {
      handle: c.handle,
      title: c.title,
      imageUrl: c.imageUrl,
      productCount: c.productCount,
      indexedAt: new Date(),
    },
  });
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
    await deleteMissing("page", shopId, seen);
  }
  return seen.length;
}

/**
 * "Delete everything except these ids", without sending every surviving id as a
 * bind parameter. Reads the stored ids (small tables) and deletes the difference
 * in bounded chunks.
 */
async function deleteMissing(
  model: "collection" | "page",
  shopId: string,
  keep: string[],
) {
  const keepSet = new Set(keep);
  const CHUNK = 500;

  if (model === "collection") {
    const existing = await prisma.collection.findMany({
      where: { shopId },
      select: { collectionId: true },
    });
    const stale = existing
      .map((r) => r.collectionId)
      .filter((id) => !keepSet.has(id));
    for (let i = 0; i < stale.length; i += CHUNK) {
      await prisma.collection.deleteMany({
        where: { shopId, collectionId: { in: stale.slice(i, i + CHUNK) } },
      });
    }
    return;
  }

  const existing = await prisma.page.findMany({
    where: { shopId },
    select: { pageId: true },
  });
  const stale = existing.map((r) => r.pageId).filter((id) => !keepSet.has(id));
  for (let i = 0; i < stale.length; i += CHUNK) {
    await prisma.page.deleteMany({
      where: { shopId, pageId: { in: stale.slice(i, i + CHUNK) } },
    });
  }
}

/**
 * Recompute which products belong to one collection.
 *
 * `collections/update` fires whenever a merchant edits a collection or a smart
 * collection's rules re-evaluate — which is exactly when membership changes.
 * Previously that webhook was subscribed, routed, and then ignored, so
 * collection-scoped search and the collection facet stayed wrong until the next
 * full catalog sync.
 */
export async function reconcileCollectionMembership(
  shopId: string,
  admin: AdminGraphql,
  collectionGid: string,
  handle: string,
  opts: { maxProducts?: number } = {},
): Promise<number> {
  const maxProducts = opts.maxProducts ?? 5000;
  const memberIds: string[] = [];
  let cursor: string | null = null;

  do {
    const res = await admin.graphql(
      `#graphql
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          handle
          products(first: 250, after: $cursor) {
            edges { node { id } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionGid, cursor } },
    );
    const json = await res.json();
    const conn = json.data?.collection?.products;
    if (!conn) break;
    for (const edge of conn.edges ?? []) memberIds.push(gidId(edge.node.id));
    cursor =
      conn.pageInfo?.hasNextPage && memberIds.length < maxProducts
        ? conn.pageInfo.endCursor
        : null;
  } while (cursor);

  // Two set operations rather than a read-modify-write per product: add the
  // handle where it is missing, remove it where it no longer belongs.
  await prisma.$executeRaw`
    UPDATE "Product"
    SET "collections" = array_append("collections", ${handle})
    WHERE "shopId" = ${shopId}
      AND "productId" = ANY(${memberIds}::text[])
      AND NOT (${handle} = ANY("collections"))`;

  await prisma.$executeRaw`
    UPDATE "Product"
    SET "collections" = array_remove("collections", ${handle})
    WHERE "shopId" = ${shopId}
      AND ${handle} = ANY("collections")
      AND NOT ("productId" = ANY(${memberIds}::text[]))`;

  return memberIds.length;
}

/** A collection was deleted — drop the mirror row and every membership. */
export async function removeCollection(shopId: string, collectionId: string) {
  const row = await prisma.collection.findUnique({
    where: { shopId_collectionId: { shopId, collectionId } },
    select: { handle: true },
  });
  if (row?.handle) {
    await prisma.$executeRaw`
      UPDATE "Product"
      SET "collections" = array_remove("collections", ${row.handle})
      WHERE "shopId" = ${shopId} AND ${row.handle} = ANY("collections")`;
  }
  await prisma.collection.deleteMany({ where: { shopId, collectionId } });
}

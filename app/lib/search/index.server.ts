// Engine factory. Today: Postgres. Swapping to Meilisearch/Typesense later means
// adding a case here + one new class implementing SearchEngine — callers are untouched.
import type { SearchEngine } from "./types";
import { PostgresSearchEngine } from "./postgres.server";

let engine: SearchEngine | null = null;

export function getSearchEngine(): SearchEngine {
  if (engine) return engine;
  const backend = process.env.SEARCH_BACKEND ?? "postgres";
  switch (backend) {
    case "postgres":
    default:
      engine = new PostgresSearchEngine();
  }
  return engine;
}

export * from "./types";

// Applies prisma/sql/search_index.sql — the tsvector/pg_trgm/unaccent layer
// that Prisma can't model natively. Idempotent. Run after `prisma migrate`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

// Plain node scripts don't auto-load .env (only the Prisma CLI does).
try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on ambient environment variables.
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, "..", "prisma", "sql", "search_index.sql");
const sql = readFileSync(sqlPath, "utf8");

// DDL (CREATE EXTENSION / generated columns / indexes) must run over the direct
// connection, not the pgBouncer pool — prefer DIRECT_URL when present.
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

// Split into individual commands. Prisma's raw exec uses the extended protocol,
// which rejects multiple commands per call — so each statement must be sent alone.
// 1. Strip line comments (-- to EOL). Safe here: our string literals contain no "--".
// 2. Split on ";" but only OUTSIDE dollar-quoted bodies ($$...$$), so the
//    CREATE FUNCTION body stays intact.
function splitStatements(text) {
  const noComments = text
    .split("\n")
    .map((l) => {
      const idx = l.indexOf("--");
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join("\n");

  const statements = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < noComments.length; i++) {
    if (noComments.slice(i, i + 2) === "$$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    const ch = noComments[i];
    if (ch === ";" && !inDollar) {
      const s = current.trim();
      if (s) statements.push(s);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

try {
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`✔ Applied search index (${statements.length} statements).`);
} catch (e) {
  console.error("x Failed to apply search index:", e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

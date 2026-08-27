// Shared helper: bundle a pure (no-DB) module from app/lib with esbuild so tests
// exercise the REAL source instead of a hand-copied duplicate that silently drifts.
import { build } from "esbuild";
import { writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} relImport  e.g. "../app/lib/search/normalize"
 * @param {string} tag        unique file tag so parallel bundles don't collide
 */
export async function bundleModule(relImport, tag) {
  const entry = join(testDir, `_${tag}.entry.generated.ts`);
  const outfile = join(testDir, `_${tag}.bundle.generated.mjs`);
  writeFileSync(entry, `export * from "${relImport}";\n`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    absWorkingDir: process.cwd(),
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(entry, { force: true });
  rmSync(outfile, { force: true });
  return mod;
}

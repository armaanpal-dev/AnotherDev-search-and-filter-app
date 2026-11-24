// Theme inspection helpers. Pure; tested in test/features.test.mjs.

/** uid from extensions/anotherdev-search/shopify.extension.toml */
export const EXTENSION_UID = "be952288-1603-a507-a5d5-bca4d530b15aadcce765";

/**
 * Is our app embed present and enabled in a theme's settings_data.json?
 * Block types look like `shopify://apps/<app>/blocks/app-embed/<extension uid>`.
 * Returns null when the file cannot be read or parsed (status unknown).
 */
export function embedEnabled(settingsJson: string): boolean | null {
  if (!settingsJson) return null;
  try {
    // settings_data.json may open with a /* comment */ that JSON.parse rejects.
    const parsed = JSON.parse(settingsJson.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
    const blocks = (parsed.current ?? parsed)?.blocks ?? {};
    return Object.values(blocks).some((b: any) => {
      const type = String(b?.type ?? "");
      return type.includes("/blocks/app-embed/") && type.endsWith(EXTENSION_UID) && b?.disabled !== true;
    });
  } catch {
    return null;
  }
}

// Activating the purchase-attribution Web Pixel.
//
// A web pixel extension existing in the app is not enough: Shopify only runs it
// once the app has created a WebPixel record for that shop, with its settings.
// This is that call, kept idempotent so it can be made from a settings save, a
// re-enable, or a repair without the merchant ever seeing an error about a pixel
// that was already there.

import { DEFAULT_PROXY_BASE } from "./proxy.server";

// Matches the shape of the client returned by authenticate.admin(request).
// Loosely typed on the variables bag for the same reason the sync modules are:
// the generated Admin client parameterises `variables` by the operation, which a
// structural type naming `unknown` is not assignable to.
type AdminGraphql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

export type PixelState = "active" | "inactive" | "unavailable";

const PIXEL_QUERY = `#graphql
  query WebPixelStatus {
    webPixel { id settings }
  }`;

const PIXEL_CREATE = `#graphql
  mutation WebPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message code }
    }
  }`;

const PIXEL_UPDATE = `#graphql
  mutation WebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message code }
    }
  }`;

const PIXEL_DELETE = `#graphql
  mutation WebPixelDelete($id: ID!) {
    webPixelDelete(id: $id) {
      deletedWebPixelId
      userErrors { field message code }
    }
  }`;

/** The settings blob the pixel reads at runtime. Shopify stores it as JSON. */
function pixelSettings(): string {
  return JSON.stringify({ proxyBase: DEFAULT_PROXY_BASE });
}

/**
 * Is the pixel currently installed for this shop?
 *
 * Returns "unavailable" rather than throwing when the shop has not granted the
 * pixel scopes yet: the Settings page has to be able to render a truthful
 * "not connected" state without the whole loader failing.
 */
export async function getPixelState(admin: AdminGraphql): Promise<PixelState> {
  try {
    const res = await admin.graphql(PIXEL_QUERY);
    const json = await res.json();
    if (json.errors?.length) return "unavailable";
    return json.data?.webPixel?.id ? "active" : "inactive";
  } catch {
    return "unavailable";
  }
}

/**
 * Install the pixel, or refresh its settings if it is already there.
 *
 * `webPixelCreate` fails with TAKEN when a pixel exists, which is the normal
 * path on every call after the first — so that is handled as success plus an
 * update, not as an error to surface.
 */
export async function ensureWebPixel(
  admin: AdminGraphql,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const existing = await admin.graphql(PIXEL_QUERY);
    const existingJson = await existing.json();
    if (existingJson.errors?.length) {
      return {
        ok: false,
        error:
          "This store has not granted the app permission to manage pixels. Reinstall the app to approve the updated permissions.",
      };
    }

    const id: string | undefined = existingJson.data?.webPixel?.id;
    const variables = { webPixel: { settings: pixelSettings() } };

    if (id) {
      const res = await admin.graphql(PIXEL_UPDATE, {
        variables: { id, ...variables },
      });
      const json = await res.json();
      const errs = json.data?.webPixelUpdate?.userErrors ?? [];
      return errs.length
        ? { ok: false, error: errs.map((e: { message: string }) => e.message).join("; ") }
        : { ok: true };
    }

    const res = await admin.graphql(PIXEL_CREATE, { variables });
    const json = await res.json();
    const errs: { message: string; code?: string }[] =
      json.data?.webPixelCreate?.userErrors ?? [];
    // Someone else won the race, or a stale read: the pixel exists, which is
    // the outcome we wanted.
    if (errs.some((e) => e.code === "TAKEN")) return { ok: true };
    return errs.length
      ? { ok: false, error: errs.map((e) => e.message).join("; ") }
      : { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Shopify." };
  }
}

/** Remove the pixel — the merchant turning purchase tracking off. */
export async function removeWebPixel(
  admin: AdminGraphql,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const existing = await admin.graphql(PIXEL_QUERY);
    const json = await existing.json();
    const id: string | undefined = json.data?.webPixel?.id;
    // Nothing installed is the state that was asked for.
    if (!id) return { ok: true };

    const res = await admin.graphql(PIXEL_DELETE, { variables: { id } });
    const delJson = await res.json();
    const errs = delJson.data?.webPixelDelete?.userErrors ?? [];
    return errs.length
      ? { ok: false, error: errs.map((e: { message: string }) => e.message).join("; ") }
      : { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Shopify." };
  }
}

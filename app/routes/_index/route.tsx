import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * The app root always goes to the dashboard.
 *
 * This used to render a marketing page unless the request carried `shop`, then
 * unless it carried any of shop/host/embedded/id_token/session. Both were wrong
 * for the same reason: once App Bridge is running, clicking the app's name in
 * the admin sidebar is a CLIENT-SIDE navigation to "/" with no query string at
 * all. No amount of parameter sniffing can catch that, so the merchant landed on
 * a marketing page inside their own admin.
 *
 * The app is embedded and App Store distributed, so its URL is only ever opened
 * from a Shopify surface. Redirecting unconditionally is both simpler and
 * correct; a direct visitor with no session is handled by `authenticate.admin`
 * in /app, which renders App Bridge and sends them to the admin.
 *
 * The public marketing copy now lives at /about.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  throw redirect(qs ? `/app?${qs}` : "/app");
};

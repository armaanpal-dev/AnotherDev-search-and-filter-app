// App-wide chrome rendered by the layout (app.tsx): the breadcrumb trail and
// the page-loading indicator. Every page gets both without any per-page code.
import { useEffect } from "react";
import { Link, useLocation, useNavigation } from "react-router";
import { trailFor } from "../lib/breadcrumbs";
import { BRAND, BrandStyles } from "./brand";

/**
 * "Dashboard › Search › Product pinning", each step a client-side link.
 * React Router's Link, not a plain href: inside the embedded iframe an absolute
 * href would reload the whole document instead of navigating the app.
 */
export function Breadcrumbs() {
  const { pathname, search } = useLocation();
  const trail = trailFor(pathname, search);
  if (!trail.length) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        // Lines up with the s-page content column.
        maxWidth: 1000,
        margin: "0 auto",
        padding: "14px 16px 0",
        boxSizing: "border-box",
        fontSize: 13,
      }}
    >
      <ol style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
        {trail.map((c, i) => (
          <li key={c.label + i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 && (
              <span aria-hidden="true" style={{ color: "#8a8a8a" }}>
                ›
              </span>
            )}
            {c.href ? (
              <Link to={c.href} className="adsf-crumb" style={{ color: BRAND.violet, textDecoration: "none", fontWeight: 500 }}>
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" style={{ color: "#303030", fontWeight: 600 }}>
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export { BrandStyles };

/**
 * Shown while a page is loading: a brand-gradient bar across the top of the
 * app, and Shopify's own admin loading indicator via App Bridge.
 */
export function PageLoader() {
  const navigation = useNavigation();
  const loading = navigation.state !== "idle";

  useEffect(() => {
    try {
      (window as any).shopify?.loading?.(loading);
    } catch {
      /* App Bridge not ready yet */
    }
  }, [loading]);

  if (!loading) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading"
      aria-busy="true"
      style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, zIndex: 1000, overflow: "hidden", background: "rgba(140,92,255,.15)" }}
    >
      <style>{`@keyframes adsf-load{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion: reduce){.adsf-load-bar{animation:none!important;width:100%!important}}`}</style>
      <div
        className="adsf-load-bar"
        style={{ width: "40%", height: "100%", background: BRAND.gradient, animation: "adsf-load 1.1s ease-in-out infinite" }}
      />
    </div>
  );
}

// Breadcrumb trail for the admin, derived from the URL. Pure; tested in
// test/features.test.mjs. The last crumb is the current page (no link).

export interface Crumb {
  label: string;
  href?: string;
}

const SECTIONS = {
  filters: { label: "Filters", href: "/app/filters" },
  search: { label: "Search", href: "/app/search" },
  analytics: { label: "Analytics", href: "/app/analytics" },
  collections: { label: "Collections", href: "/app/collections" },
  settings: { label: "Settings", href: "/app/settings" },
} as const;
type Section = keyof typeof SECTIONS;

const SETTINGS_TABS: Record<string, string> = {
  search: "Search settings",
  filters: "Filter appearance",
  cards: "Product cards",
  advanced: "Advanced",
};

/** Where a page lives and what it is called. null = section landing page. */
function locate(path: string, q: URLSearchParams): { section: Section; page: string | null } | null {
  const view = q.get("view");
  switch (path) {
    case "/app/filters":
      return { section: "filters", page: null };
    case "/app/filters/manage":
      return { section: "filters", page: "Manage filters" };
    case "/app/filter-tools":
      return { section: "filters", page: "Filter groups and values" };
    case "/app/search":
      return { section: "search", page: null };
    case "/app/search-tools":
      return {
        section: "search",
        page:
          view === "banners" ? "Banners"
          : view === "blacklist" ? "Blacklist suggestions"
          : view === "empty" ? "Empty search"
          : "Search tools",
      };
    case "/app/synonyms":
      return { section: "search", page: "Synonyms" };
    case "/app/preview":
      return { section: "search", page: "Test search" };
    case "/app/merchandising":
      return {
        section: q.get("scope") === "collection" ? "collections" : "search",
        page:
          view === "pinning" ? "Product pinning"
          : view === "rules" ? "Merchandising rules"
          : view === "redirects" ? "Page redirects"
          : "Merchandising",
      };
    case "/app/analytics":
      return { section: "analytics", page: null };
    case "/app/collections":
      return { section: "collections", page: null };
    case "/app/settings":
      return { section: "settings", page: null };
    case "/app/settings/general":
      return { section: "settings", page: SETTINGS_TABS[q.get("tab") ?? ""] ?? "General settings" };
    case "/app/theme-setup":
      return { section: "settings", page: "Theme setup" };
    case "/app/sync":
      return { section: "settings", page: "Index" };
    case "/app/catalog-health":
      return { section: "settings", page: "Catalog check" };
    case "/app/plans":
      return { section: "settings", page: "Plans" };
    default:
      return null;
  }
}

/** Dashboard › Section › Page. Empty on the dashboard and unknown pages. */
export function trailFor(pathname: string, search = ""): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/app") return [];
  const loc = locate(path, new URLSearchParams(search));
  if (!loc) return [];
  const section = SECTIONS[loc.section];
  const trail: Crumb[] = [{ label: "Dashboard", href: "/app" }];
  if (loc.page) {
    trail.push({ label: section.label, href: section.href }, { label: loc.page });
  } else {
    trail.push({ label: section.label });
  }
  return trail;
}

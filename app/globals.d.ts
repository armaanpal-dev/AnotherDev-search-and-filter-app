declare module "*.css";

// The template uses <s-app-nav> but @shopify/polaris-types doesn't declare it.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": import("react").DetailedHTMLProps<
      import("react").HTMLAttributes<HTMLElement>,
      HTMLElement
    >;
  }
}

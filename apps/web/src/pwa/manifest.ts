import { resolveProductName } from "../config/product.ts";

export interface ProductManifestOptions { productName?: string }

export function createProductManifest(options: ProductManifestOptions = {}) {
  const name = resolveProductName(options.productName);
  return {
    id: "/",
    name,
    short_name: name.slice(0, 24),
    description: "Private image and PDF intake workspace",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f8fa",
    theme_color: "#1f63d8",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/app-icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}

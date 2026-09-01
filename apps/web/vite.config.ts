import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";

import { renderProductTemplate, resolveProductName } from "./src/config/product.ts";
import { createProductManifest } from "./src/pwa/manifest.ts";
import { PRODUCTION_SECURITY_HEADERS } from "./src/pwa/security.ts";

const apiOrigin = process.env["IPW_API_ORIGIN"] ?? "http://127.0.0.1:8780";

function productManifestPlugin(): Plugin {
  const productName = resolveProductName(process.env["VITE_PRODUCT_NAME"]);
  const manifest = JSON.stringify(createProductManifest({ productName }), null, 2);
  const offline = renderProductTemplate(
    readFileSync(new URL("./offline.template.html", import.meta.url), "utf8"),
    productName,
  );
  return {
    name: "ipw-product-assets",
    transformIndexHtml(html) {
      return renderProductTemplate(html, productName);
    },
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_request, response) => {
        response.setHeader("content-type", "application/manifest+json");
        response.end(manifest);
      });
      server.middlewares.use("/offline.html", (_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(offline);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
      this.emitFile({ type: "asset", fileName: "offline.html", source: offline });
    },
  };
}

export default defineConfig({
  plugins: [react(), productManifestPlugin()],
  server: {
    proxy: {
      "/v1": apiOrigin,
    },
  },
  preview: {
    headers: PRODUCTION_SECURITY_HEADERS,
    proxy: {
      "/v1": apiOrigin,
    },
  },
  build: {
    sourcemap: true,
  },
});

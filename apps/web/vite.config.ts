import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { createProductManifest } from "./src/pwa/manifest.ts";

function productManifestPlugin(): Plugin {
  const source = JSON.stringify(createProductManifest({ productName: process.env["VITE_PRODUCT_NAME"] }), null, 2);
  return {
    name: "ipw-product-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_request, response) => {
        response.setHeader("content-type", "application/manifest+json");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), productManifestPlugin()],
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8780",
    },
  },
  build: {
    sourcemap: true,
  },
});

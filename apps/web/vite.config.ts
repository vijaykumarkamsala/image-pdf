import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

import { renderProductTemplate, resolveProductName } from "./src/config/product.ts";
import { createProductManifest } from "./src/pwa/manifest.ts";
import { PRODUCTION_SECURITY_HEADERS } from "./src/pwa/security.ts";

const apiOrigin = process.env["IPW_API_ORIGIN"] ?? "http://127.0.0.1:8780";
const localResearchModel = new URL(
  "../../.tools/models/realesr-general-x4v3-tile128-8dc7edb9ac80.onnx",
  import.meta.url,
);
const localNaturalResearchModel = new URL(
  "../../.tools/models/realesr-general-x4v3-dni50-tile128-8dc7edb9ac80-1641f8c4464b.onnx",
  import.meta.url,
);

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

function localResearchModelPlugin(): Plugin {
  const models = new Map([
    ["/quality-models/realesr-general-x4v3-tile128.onnx", localResearchModel],
    ["/quality-models/realesr-general-x4v3-dni50-tile128.onnx", localNaturalResearchModel],
  ]);
  const serve = (request: IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => {
    const model = models.get(request.url?.split("?", 1)[0] ?? "");
    if (!model) {
      next();
      return;
    }
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "Research-only model access is restricted to the local machine." }));
      return;
    }
    if (!existsSync(model)) {
      const message = JSON.stringify({ error: "Run the governed local Real-ESRGAN export before testing." });
      response.statusCode = 503;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(message);
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/onnx");
    response.setHeader("Content-Length", String(statSync(model).size));
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-IPW-Model-Usage", "local-research-only");
    createReadStream(model).pipe(response);
  };
  return {
    name: "ipw-local-research-image-model",
    configureServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig(({ mode }) => {
  const imageQualityStandalone = mode === "image-quality";
  return {
    plugins: [react(), productManifestPlugin(), localResearchModelPlugin()],
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
      // The normal workspace build keeps reviewable maps. The public dev
      // editor image contains only deployable artifacts, not source maps.
      sourcemap: !imageQualityStandalone,
      outDir: imageQualityStandalone ? "dist-image-quality" : "dist",
      rollupOptions: imageQualityStandalone
        ? { input: fileURLToPath(new URL("./image-quality.html", import.meta.url)) }
        : undefined,
    },
  };
});

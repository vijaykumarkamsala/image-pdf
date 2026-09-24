import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://storage.googleapis.com",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join("; "),
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function setHeaders(response, headers) {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

function sendText(response, status, message, method = "GET") {
  const body = Buffer.from(message);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.length),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(method === "HEAD" ? undefined : body);
}

function resolvedAsset(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

export function createImageQualityServer({ root, logger = console } = {}) {
  const staticRoot = resolve(root ?? fileURLToPath(new URL("./dist", import.meta.url)));
  const standaloneIndex = resolve(staticRoot, "image-quality.html");
  const indexPath = existsSync(standaloneIndex) ? standaloneIndex : resolve(staticRoot, "index.html");
  if (!existsSync(indexPath)) throw new Error(`Built web application is missing: ${indexPath}`);

  return createServer((request, response) => {
    setHeaders(response, SECURITY_HEADERS);
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed", method);
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/healthz") {
      sendText(response, 200, "ok\n", method);
      return;
    }
    if (requestUrl.pathname === "/") {
      response.writeHead(302, { "Cache-Control": "no-store", Location: "/image-quality" });
      response.end();
      return;
    }

    const assetPath = resolvedAsset(staticRoot, requestUrl.pathname);
    const asset = assetPath && existsSync(assetPath) && statSync(assetPath).isFile() ? assetPath : null;
    const isEditorRoute = requestUrl.pathname === "/image-quality"
      || requestUrl.pathname.startsWith("/image-quality/");
    const selected = asset ?? (isEditorRoute ? indexPath : null);
    if (!selected) {
      sendText(response, 404, "Not found", method);
      return;
    }

    const extension = extname(selected).toLowerCase();
    const immutable = requestUrl.pathname.startsWith("/assets/")
      && /-[a-zA-Z0-9_-]{8,}\.[^.]+$/.test(requestUrl.pathname);
    response.writeHead(200, {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Length": String(statSync(selected).size),
      "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
    });
    if (method === "HEAD") response.end();
    else createReadStream(selected).on("error", (error) => {
      logger.error("static response failed", error);
      response.destroy();
    }).pipe(response);
  });
}

function start() {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const server = createImageQualityServer({});
  server.listen(port, "0.0.0.0", () => console.log(`Image Quality Editor listening on ${port}`));
  const shutdown = () => server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();

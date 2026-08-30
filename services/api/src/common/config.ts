export interface ApiConfig {
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const host = env["IPW_API_HOST"] || "127.0.0.1";
  const rawPort = env["IPW_API_PORT"] || env["PORT"] || "8780";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("IPW_API_PORT must be an integer between 1 and 65535");
  }

  if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "::1") {
    throw new Error("IPW_API_HOST must be a bind address, not a public URL");
  }

  return { host, port };
}

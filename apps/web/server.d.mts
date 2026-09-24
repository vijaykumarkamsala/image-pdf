import type { Server } from "node:http";

export interface ImageQualityServerOptions {
  root?: string;
  logger?: Pick<Console, "error">;
}

export function createImageQualityServer(options?: ImageQualityServerOptions): Server;

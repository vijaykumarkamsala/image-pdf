import { Body, Controller, Get, Header, Headers, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";

import { ImageQualityService } from "./image-quality.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller()
export class ImageQualityController {
  constructor(private readonly imageQuality: ImageQualityService) {}

  @Get("upload-sessions/:uploadSessionId/face-quality-capabilities")
  @Header("Cache-Control", "private, no-store, max-age=0")
  faceCapabilities(
    @Headers() headers: RequestHeaders,
    @Param("uploadSessionId") uploadSessionId: string,
  ) {
    return this.imageQuality.faceCapabilities(headers, uploadSessionId);
  }

  @Post("upload-sessions/:uploadSessionId/face-quality-candidate-requests")
  createFaceCandidates(
    @Headers() headers: RequestHeaders,
    @Param("uploadSessionId") uploadSessionId: string,
    @Body() body: unknown,
  ) {
    return this.imageQuality.createFaceCandidates(headers, uploadSessionId, body);
  }

  @Post("upload-sessions/:uploadSessionId/image-quality-requests")
  create(
    @Headers() headers: RequestHeaders,
    @Param("uploadSessionId") uploadSessionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.imageQuality.create(headers, uploadSessionId, body);
  }

  @Get("image-quality-requests/:requestId")
  get(@Headers() headers: RequestHeaders, @Param("requestId") requestId: string) {
    return this.imageQuality.get(headers, requestId);
  }

  @Get("workspaces/:workspaceId/image-quality-requests/:requestId")
  getForWorkspace(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("requestId") requestId: string,
  ) {
    return this.imageQuality.getForWorkspace(headers, workspaceId, requestId);
  }

  @Get("image-quality-requests/:requestId/download")
  async download(
    @Headers() headers: RequestHeaders,
    @Param("requestId") requestId: string,
    @Res() response: Response,
  ) {
    const delivery = await this.imageQuality.download(headers, requestId);
    this.sendDelivery(response, delivery, "attachment");
  }

  @Get("image-quality-requests/:requestId/view")
  async view(
    @Headers() headers: RequestHeaders,
    @Param("requestId") requestId: string,
    @Res() response: Response,
  ) {
    const delivery = await this.imageQuality.view(headers, requestId);
    this.sendDelivery(response, delivery, "inline");
  }

  @Get("workspaces/:workspaceId/image-quality-requests/:requestId/download")
  async downloadForWorkspace(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("requestId") requestId: string,
    @Res() response: Response,
  ) {
    const delivery = await this.imageQuality.downloadForWorkspace(headers, workspaceId, requestId);
    this.sendDelivery(response, delivery, "attachment");
  }

  @Get("workspaces/:workspaceId/image-quality-requests/:requestId/view")
  async viewForWorkspace(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("requestId") requestId: string,
    @Res() response: Response,
  ) {
    const delivery = await this.imageQuality.viewForWorkspace(headers, workspaceId, requestId);
    this.sendDelivery(response, delivery, "inline");
  }

  private sendDelivery(
    response: Response,
    delivery: Awaited<ReturnType<ImageQualityService["download"]>>,
    disposition: "attachment" | "inline",
  ) {
    if (delivery.downloadUrl) {
      response
        .setHeader("Cache-Control", "private, no-store, max-age=0")
        .redirect(302, delivery.downloadUrl);
      return;
    }
    if (!delivery.bytes) throw new Error("download delivery is incomplete");
    response
      .type(delivery.mediaType)
      .setHeader("Cache-Control", "private, no-store, max-age=0")
      .setHeader("Pragma", "no-cache")
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Disposition", `${disposition}; filename="${delivery.filename}"`)
      .setHeader("Content-Length", String(delivery.bytes.byteLength))
      .send(Buffer.from(delivery.bytes));
  }
}

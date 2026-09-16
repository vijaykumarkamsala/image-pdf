import { Body, Controller, Get, Header, Headers, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { FaceQualityService } from "./face-quality.service.js";
type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller("upload-sessions/:uploadId")
export class FaceQualityController {
  constructor(private readonly face: FaceQualityService) {}
  @Post("face-quality-compositions")
  compose(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string, @Body() body: unknown) {
    return this.face.compose(headers, uploadId, body);
  }
  @Get("face-quality-jobs/:id")
  @Header("Cache-Control", "private, no-store, max-age=0")
  get(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string, @Param("id") id: string) {
    return this.face.get(headers, uploadId, id);
  }
  @Post("face-quality-jobs/:id/cancel")
  cancel(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string, @Param("id") id: string) {
    return this.face.cancel(headers, uploadId, id);
  }
  @Post("face-quality-jobs/:id/retry")
  retry(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string, @Param("id") id: string) {
    return this.face.retry(headers, uploadId, id);
  }
  @Get("face-quality-jobs/:id/download")
  async download(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string,
    @Param("id") id: string, @Res() response: Response) {
    const value = await this.face.download(headers, uploadId, id);
    response.setHeader("Cache-Control", "private, no-store, max-age=0").setHeader("X-Content-Type-Options", "nosniff");
    if (value.url) { response.redirect(302, value.url); return; }
    response.type("image/png").setHeader("Content-Disposition", `attachment; filename="reviewed-face-${id}.png"`)
      .setHeader("Content-Length", String(value.bytes!.byteLength)).send(Buffer.from(value.bytes!));
  }
}

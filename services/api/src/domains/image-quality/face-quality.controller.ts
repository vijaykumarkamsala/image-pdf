import { Body, Controller, Get, Header, Headers, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { DomainError } from "../../kernel/errors.js";
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
  @Get("face-quality-jobs/:id/candidates/:candidateId/:kind")
  async candidateArtifact(@Headers() headers: RequestHeaders, @Param("uploadId") uploadId: string,
    @Param("id") id: string, @Param("candidateId") candidateId: string,
    @Param("kind") rawKind: string, @Res() response: Response) {
    const kind = rawKind === "pixels" || rawKind === "mask" ? rawKind : null;
    if (!kind) throw new DomainError(404, "face-quality-candidate-not-found", "Face candidate artifact was not found");
    const value = await this.face.candidateArtifact(headers, uploadId, id, candidateId, kind);
    response.type("application/octet-stream")
      .setHeader("Cache-Control", "private, no-store, max-age=0")
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Length", String(value.bytes.byteLength))
      .setHeader("X-IPW-Face-Candidate-SHA256", value.candidateSha256)
      .setHeader("X-IPW-Artifact-SHA256", value.artifactSha256)
      .setHeader("X-IPW-Face-Region-Width", String(value.width))
      .setHeader("X-IPW-Face-Region-Height", String(value.height))
      .setHeader("X-IPW-Face-Bit-Depth", String(value.bitDepth))
      .setHeader("X-IPW-Face-Artifact-Kind", value.kind)
      .send(Buffer.from(value.bytes));
  }
}

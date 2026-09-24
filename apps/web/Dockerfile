# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/ipw

COPY package.json package-lock.json ./
COPY apps/browser-lab/package.json apps/browser-lab/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts-ts/package.json packages/contracts-ts/package.json
COPY services/api/package.json services/api/package.json
RUN npm ci --ignore-scripts

COPY apps/web apps/web
COPY packages/contracts-ts packages/contracts-ts
RUN npm run build:image-quality --workspace ipw-web \
 && ! find apps/web/dist-image-quality -type f \( -name '*.onnx' -o -name '*.pth' \) -print -quit | grep -q . \
 && ! find apps/web/dist-image-quality -type f \( -name '*Pdf*' -o -name '*Studio*' -o -name '*BatchWorkspace*' \) -print -quit | grep -q .

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=build --chown=node:node /opt/ipw/apps/web/dist-image-quality ./dist
COPY --chown=node:node apps/web/server.mjs ./server.mjs

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

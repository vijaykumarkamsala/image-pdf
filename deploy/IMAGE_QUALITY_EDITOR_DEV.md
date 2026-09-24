# Image Quality Editor dev service

This service is the isolated, browser-local `/image-quality` experience. It is
not the workspace API or the private processing worker. Uploaded bytes and
processed results remain in the customer's browser for this delivery.

The runtime deliberately exposes only `/image-quality`, static assets and
`/healthz`. `/` redirects to `/image-quality`; unrelated application routes
return 404. The standalone Vite build excludes PDF, Studio and batch-editor
chunks, source maps, and all `.onnx`/`.pth` research weights.

## Build and verify locally

```powershell
docker build --file apps/web/Dockerfile --tag ipw-image-quality-web:dev .
docker run --rm --publish 127.0.0.1:4197:8080 ipw-image-quality-web:dev
```

Open `http://127.0.0.1:4197/image-quality`. The immutable production input is
the pinned Node image in `apps/web/Dockerfile`; Cloud Run and local Docker build
the same Linux image.

## Dev Cloud Run release

Use a dedicated GCP dev project and Artifact Registry repository. Enabling APIs,
linking billing, creating the repository and making a service public are
external state changes and are intentionally performed as explicit release
operations, not by the application build.

```powershell
$project = "your-dedicated-dev-project"
$region = "asia-south1"
$repository = "ipw-dev"
$service = "ipw-image-quality-dev"
$tag = (git rev-parse HEAD)
$image = "$region-docker.pkg.dev/$project/$repository/image-quality-web:$tag"

gcloud auth configure-docker "$region-docker.pkg.dev"
docker tag ipw-image-quality-web:dev $image
docker push $image
gcloud run deploy $service `
  --project $project `
  --region $region `
  --image $image `
  --allow-unauthenticated `
  --cpu 1 `
  --memory 512Mi `
  --concurrency 80 `
  --min-instances 0 `
  --max-instances 2 `
  --port 8080
```

Deploy by immutable commit tag and record the resulting image digest. This
public dev service is safe only while it remains browser-local. Do not attach
the private worker or storage bucket directly to its public identity.

# Deploying to Cloud Run

Three environments, **one image**. The container is built once and the same
digest is promoted from dev to staging to production; only the configuration
passed to it differs. Building per environment means staging tests something
production will never run, which is the usual root of "but it worked in
staging".

---

## Where the credentials go

Short answer: **not in the repository, and not in three variables.**

Each Cloud Run service gets *one* set of variables with that environment's
values. The prod service has no reason to know the dev bucket's name, and a
container that carries all three invites the bug where the wrong one is chosen.

| what | local | Cloud Run |
|---|---|---|
| `IPW_ENV` | `.env` | `--set-env-vars` |
| `IPW_BUCKET` | `.env` | `--set-env-vars` |
| `IPW_DATABASE_URL` | `.env` | **`--set-secrets`, from Secret Manager** |
| `IPW_HOST` / `IPW_ALLOW_PUBLIC_BIND` | not needed | `--set-env-vars` |
| credentials for signing | `gcloud auth application-default login` | nothing — the metadata service provides them |

**The database URL must come from Secret Manager, not `--set-env-vars`.** An
environment variable set on a service is readable by anyone who can describe it,
and a password typed into a deploy command lands in your shell history and in
your CI logs. Secret Manager also lets the password be rotated without a
redeploy.

### Local

```bash
cp .env.example .env      # then fill it in; .env is gitignored
```

Everything in it is optional. With an empty `.env` the workspace still runs and
still processes files — it simply has nowhere to persist them.

### Creating the secrets, once per environment

```bash
ENV=dev                                   # dev | staging | production
PROJECT=your-project-id

printf '%s' 'postgresql://user:password@host:5432/dbname' \
  | gcloud secrets create "ipw-database-url-$ENV" \
      --project="$PROJECT" --data-file=- --replication-policy=automatic

# Let the service read it, and nothing else.
gcloud secrets add-iam-policy-binding "ipw-database-url-$ENV" \
  --project="$PROJECT" \
  --member="serviceAccount:ipw-$ENV@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Rotating later is `gcloud secrets versions add` — no redeploy, because the
service reads `latest`.

---

## Build and deploy

```bash
PROJECT=your-project-id
REGION=asia-south1
ENV=dev
BUCKET=your-dev-bucket

# Build once. The digest is what gets promoted.
gcloud builds submit --project="$PROJECT" \
  --tag="$REGION-docker.pkg.dev/$PROJECT/ipw/workspace:$(git rev-parse --short HEAD)"

gcloud run deploy "ipw-$ENV" \
  --project="$PROJECT" --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT/ipw/workspace:$(git rev-parse --short HEAD)" \
  --service-account="ipw-$ENV@$PROJECT.iam.gserviceaccount.com" \
  --set-env-vars="IPW_ENV=$ENV,IPW_BUCKET=$BUCKET,IPW_HOST=0.0.0.0,IPW_ALLOW_PUBLIC_BIND=1" \
  --set-secrets="IPW_DATABASE_URL=ipw-database-url-$ENV:latest" \
  --min-instances=1 \
  --memory=2Gi \
  --cpu=2 \
  --timeout=600 \
  --concurrency=8 \
  --no-allow-unauthenticated
```

### Why each of those flags

- **`--no-allow-unauthenticated`** — the service has no sign-in yet. Public
  ingress makes it an image processor strangers can run at your expense. This
  stays until authentication exists; it is not a temporary inconvenience.
- **`--min-instances=1`** — a cold start loads model weights. Without a warm
  instance the first upscale after a quiet period feels broken.
- **`--memory=2Gi`** — a 100 MB image decoded plus a model is not small. Watch
  the actual figure and adjust; too little shows up as an opaque 503.
- **`--timeout=600`** — OCR over a long bundle takes minutes today. This is a
  ceiling to live under until the job queue exists, not a solution.
- **`--concurrency=8`** — image processing is CPU-bound, and the server is
  `http.server`. A high concurrency here means requests queue inside one
  container instead of scaling out.

### Promoting the same image

```bash
DIGEST=$(gcloud container images describe "$IMAGE" --format='value(image_summary.digest)')
gcloud run deploy ipw-staging --image="$REPO@$DIGEST"   # …then production
```

Promote the **digest**, never the tag. A tag can move; a digest is the artifact
that was tested.

---

## Checking a deployment

```bash
gcloud run services proxy "ipw-$ENV" --project="$PROJECT" --region="$REGION"
curl -s localhost:8080/api/health | python -m json.tool
```

`/api/health` reports the environment it believes it is in and every warning
about its own configuration — a missing bucket, a missing database, an unknown
environment name. A deployment that is wrong should be visible from outside,
not only in a log nobody opened.

---

## Not yet true

Written down so nobody assumes otherwise:

- **The image has never been built.** Docker is not installed on the development
  machine, so the Dockerfile is statically verified, not proven. The first
  `gcloud builds submit` is the real test.
- **Nothing persists.** `IPW_DATABASE_URL` is read and reported; no schema,
  migrations or queries exist yet.
- **Files still travel as base64 inside JSON**, so Cloud Run's request size
  limit applies. Signed uploads are the next piece of work and are what make the
  100 MB professional tier possible.
- **There is no authentication.** Everything above assumes IAM is the only thing
  between this service and the internet.

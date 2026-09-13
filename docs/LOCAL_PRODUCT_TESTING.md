# Local product testing

This runbook starts the React customer application and its NestJS API with the
explicit local identity simulator. It is for development and manual testing only.
Production uses the configured OIDC provider and never enables this simulator.

## Install and build

From the repository root:

```powershell
npm.cmd ci
npm.cmd run build --workspace ipw-api
```

## Start the API

In one PowerShell terminal:

```powershell
$env:NODE_ENV = "development"
$env:IPW_DEV_IDENTITY_ENABLED = "1"
$env:IPW_API_PORT = "8791"
$env:IPW_LOCAL_STORAGE_ROOT = "$env:LOCALAPPDATA\Temp\ipw-product-storage"
npm.cmd run start --workspace ipw-api
```

The local sign-in path is available only when both the non-production environment
and `IPW_DEV_IDENTITY_ENABLED=1` are present. The API rejects this path in
production even if the flag is accidentally set.

## Start the web application

In a second PowerShell terminal:

```powershell
$env:IPW_API_ORIGIN = "http://127.0.0.1:8791"
npm.cmd run dev --workspace ipw-web -- --host 127.0.0.1 --port 4317 --strictPort
```

Open <http://127.0.0.1:4317>. `--strictPort` prevents Vite from silently opening
the product on a different port. If either port is occupied, choose two unused
ports and keep `IPW_API_ORIGIN` aligned with the API port.

## Expected identity and guest behavior

- Top-level **Sign in** creates or opens the local test customer's personal
  workspace. No external provider screen is shown in local simulator mode.
- A guest can inspect an image or PDF without an account.
- **Sign in to continue** preserves the already inspected immutable source,
  attaches it to the personal workspace, and opens Default Files.
- An image can continue from Default Files into Image & Graphic Studio. An
  imported PDF opens its source-bound safe capability report; unsupported PDF
  mutation is not silently enabled.
- If provider completion fails, the guest page explains the failure and retains
  the temporary work for retry.

For deployed environments, configure `IPW_OIDC_ISSUER`, `IPW_OIDC_CLIENT_ID`,
`IPW_OIDC_CLIENT_SECRET` and `IPW_OIDC_REDIRECT_URI` instead. Account creation,
passwords and federation remain owned by that provider.

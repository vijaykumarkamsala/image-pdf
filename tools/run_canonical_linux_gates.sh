#!/bin/sh
set -eu

# One canonical bootstrap for every gate: compile the migration owner, bring the
# disposable PostgreSQL service to the full product schema, then run the normal
# repository gate runner unchanged.
npm run build --workspace ipw-api --silent
node tools/prepare_test_database.mjs
exec python tools/check.py --verbose

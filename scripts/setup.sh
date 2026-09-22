#!/bin/sh
# Create local secrets once. Existing nonempty configuration is preserved.
set -eu
cd "$(dirname "$0")/.."
umask 077
if [ ! -f .env ]; then cp .env.example .env; fi
for key in ADMIN_TOKEN INGEST_TOKEN ENCRYPTION_KEY; do
  if ! grep -Eq "^${key}=.+" .env; then
    value=$(openssl rand -hex 32)
    temporary=$(mktemp .env.setup.XXXXXX)
    awk -v key="$key" 'index($0,key "=") != 1 { print }' .env > "$temporary"
    printf '%s=%s\n' "$key" "$value" >> "$temporary"
    mv "$temporary" .env
  fi
done
chmod 600 .env
printf '%s\n' 'Local configuration is ready. Find ADMIN_TOKEN in .env to sign in. Keep ENCRYPTION_KEY with your database backups.'

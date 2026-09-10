#!/usr/bin/env sh
# Build dist/lnd-sweeper.html and write dist/SHA256SUMS next to it.
# Used by the release workflow and by anyone checking a release hash by hand.
set -eu

cd "$(dirname "$0")/.."

# A development-mode build inlines the dev mock and produces a different file.
# Force production; vite.config.ts also refuses to build in any other mode.
export NODE_ENV=production
# Belt and braces: nothing in the build reads these, but pin them anyway so a
# future dependency that does cannot make the output depend on the clock or TZ.
export SOURCE_DATE_EPOCH=1
export TZ=UTC
export LANG=C
export LC_ALL=C

pnpm install --frozen-lockfile --prefer-offline
pnpm build

cd dist
if [ ! -f lnd-sweeper.html ]; then
  echo "build did not produce dist/lnd-sweeper.html" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum lnd-sweeper.html > SHA256SUMS
else
  shasum -a 256 lnd-sweeper.html > SHA256SUMS
fi

echo "Built dist/lnd-sweeper.html"
cat SHA256SUMS

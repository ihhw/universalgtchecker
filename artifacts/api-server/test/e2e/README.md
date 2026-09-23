# End-to-end run and latency benchmark

Both scripts drive the **production build** (`dist/index.mjs` with the built
frontend in `dist/public`) against `test/mock-xbox.ts`, a local mock of the
Microsoft/Xbox endpoints. They show that the app's own pipeline behaves
correctly; they are **not** evidence of how live Xbox responds.

```bash
# from the repo root, after building (see replit.md → "Build & test")
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright@1   # not a repo dependency; resolved from the cwd
CHROMIUM_PATH=/path/to/chrome node <repo>/artifacts/api-server/test/e2e/e2e.mjs
node <repo>/artifacts/api-server/test/e2e/bench.mjs
```

Ports used: mock 4599, e2e server 8090, bench server 8091.

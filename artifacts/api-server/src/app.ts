import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { preWarmXboxAuth } from "./lib/xbox-auth";
import { initSniper } from "./lib/xbox-sniper";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// List mode can post several thousand names.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built frontend from the same process and port as the API, so the
// app is a single server rather than two dev processes on two ports. The
// frontend build (`pnpm run build`) copies its output into `dist/public`
// next to this bundled file; `import.meta.url` resolves to wherever this
// file actually runs from, in dev or once bundled by esbuild.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const indexHtml = path.join(publicDir, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));

  // Client-side routes (e.g. /hits, /status) must still return index.html on
  // a full page load. Static files are handled above; only a GET/HEAD that
  // reaches here (no matching file, not an /api call) falls through to it.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    if (req.path.startsWith("/api/")) { next(); return; }
    res.sendFile(indexHtml);
  });
} else {
  logger.warn(
    { publicDir },
    "No built frontend found next to the server; running API-only. Build the frontend and place its output at dist/public to serve the app from this port.",
  );
}

// Pre-warm Xbox XSTS token if a refresh token is already saved.
// This ensures the first gamertag check doesn't pay the token-refresh latency.
preWarmXboxAuth();

// Restore the sniper; a run that was watching when the server stopped resumes.
initSniper();

export default app;

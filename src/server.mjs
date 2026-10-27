import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsage } from "./usage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8787);
const host = "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

async function serveStatic(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, "index.html")) {
    send(response, 404, "Не найдено");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      send(response, 404, "Не найдено");
      return;
    }
  } catch {
    send(response, 404, "Не найдено");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}`);
  if (request.method === "GET" && url.pathname === "/api/usage") {
    try {
      const usage = await collectUsage();
      send(response, 200, JSON.stringify(usage), {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
    } catch (error) {
      send(response, 500, JSON.stringify({ message: error instanceof Error ? error.message : "Ошибка" }), {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
    return;
  }
  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }
  send(response, 405, "Метод не поддерживается");
});

server.listen(port, host, () => {
  console.log(`AI Karma: http://${host}:${port}`);
});

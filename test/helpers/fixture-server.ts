/** Tiny static file server for test/fixtures on an ephemeral 127.0.0.1 port. Unknown paths => 404. */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    void serve(req, res);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const file = fixturePath(req.url ?? "/");
  if (file === null) return notFound(res);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    notFound(res);
  }
}

/** Map a request URL to a file inside FIXTURES_DIR, or null if it would escape it. */
function fixturePath(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://fixture.invalid").pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(FIXTURES_DIR, pathname));
  return candidate.startsWith(FIXTURES_DIR) && !candidate.endsWith(sep) ? candidate : null;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

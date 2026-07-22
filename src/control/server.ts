import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfig } from "../routing/config.js";
import {
  CONTROL_SCHEMA_VERSION,
  ControlInputError,
  readControlDecision,
  readControlDecisions,
  readControlStatus,
  setRouteProfile,
  setRouterEnabled,
  validateRouteCapabilities,
} from "./config-store.js";
import {
  LocalCodexThreadCatalog,
  type CodexThreadCatalog,
} from "./codex-thread-catalog.js";
import type { GatewayAdapter } from "./gateway.js";
import { LocalOpenCodexGatewayAdapter } from "./open-codex-gateway.js";

export const DEFAULT_CONTROL_HOST = "127.0.0.1";
export const DEFAULT_CONTROL_PORT = 47_831;

export interface ControlServerOptions {
  host?: string;
  port?: number;
  configPath?: string;
  version: string;
  gatewayAdapter?: GatewayAdapter;
  threadCatalog?: CodexThreadCatalog;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 8_192) throw new ControlInputError("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function endpoint(options: ControlServerOptions): string {
  return `http://${options.host ?? DEFAULT_CONTROL_HOST}:${options.port ?? DEFAULT_CONTROL_PORT}`;
}

function isTrustedBrowserOrigin(request: IncomingMessage, options: ControlServerOptions): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === endpoint(options);
}

export function createControlServer(options: ControlServerOptions): Server {
  const gateway = options.gatewayAdapter ?? new LocalOpenCodexGatewayAdapter();
  const threadCatalog = options.threadCatalog ?? new LocalCodexThreadCatalog();
  const ownsThreadCatalog = options.threadCatalog === undefined;
  const readStatus = () =>
    readControlStatus({
      ...(options.configPath ? { configPath: options.configPath } : {}),
      endpoint: endpoint(options),
      version: options.version,
      gateway,
      threadCatalog,
    });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !isTrustedBrowserOrigin(request, options)
      ) {
        json(response, 403, { error: "cross-origin control request rejected" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, {
          schemaVersion: 2,
          controlSchemaVersion: CONTROL_SCHEMA_VERSION,
          version: options.version,
          status: "ok",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, await readStatus());
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/decision") {
        const latestDecision = await readControlDecision(options.configPath);
        json(response, 200, {
          schemaVersion: 1,
          ...(latestDecision ? { latestDecision } : {}),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/decisions") {
        const afterId = url.searchParams.get("after") ?? undefined;
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        if (
          (afterId !== undefined && (afterId.length === 0 || afterId.length > 200)) ||
          (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50))
        ) {
          json(response, 400, { error: "invalid decision cursor or limit" });
          return;
        }
        const decisions = await readControlDecisions(options.configPath, {
          ...(afterId ? { afterId } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        json(response, 200, { schemaVersion: 2, decisions });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/v1/router/enabled") {
        const body = await readJsonBody(request);
        const enabled =
          body !== null && typeof body === "object"
            ? (body as { enabled?: unknown }).enabled
            : undefined;
        if (typeof enabled !== "boolean") {
          json(response, 400, { error: "enabled must be a boolean" });
          return;
        }
        await setRouterEnabled(enabled, options.configPath);
        json(response, 200, await readStatus());
        return;
      }

      const routeMatch = /^\/v1\/routes\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && routeMatch?.[1]) {
        const name = decodeURIComponent(routeMatch[1]);
        const body = await readJsonBody(request);
        const profile = body !== null && typeof body === "object"
          ? body as { model?: unknown; effort?: unknown; fast?: unknown }
          : {};
        if (
          typeof profile.model !== "string" ||
          typeof profile.effort !== "string" ||
          typeof profile.fast !== "boolean"
        ) {
          json(response, 400, { error: "model, effort and fast are required" });
          return;
        }
        const config = await loadConfig(options.configPath);
        const gatewaySnapshot = await gateway.snapshot(config.gateway);
        validateRouteCapabilities(
          { model: profile.model, effort: profile.effort, fast: profile.fast },
          gatewaySnapshot,
        );
        await setRouteProfile(
          name,
          { model: profile.model, effort: profile.effort, fast: profile.fast },
          options.configPath,
        );
        json(response, 200, await readStatus());
        return;
      }

      if (request.method === "PUT" && url.pathname === "/v1/gateway/routed") {
        const body = await readJsonBody(request);
        const routed = body !== null && typeof body === "object"
          ? (body as { routed?: unknown }).routed
          : undefined;
        if (typeof routed !== "boolean") {
          json(response, 400, { error: "routed must be a boolean" });
          return;
        }
        const config = await loadConfig(options.configPath);
        try {
          await gateway.setRouted(routed, config.gateway);
        } catch (error) {
          json(response, 503, { error: (error as Error).message });
          return;
        }
        json(response, 200, await readStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/gateway/dashboard") {
        const config = await loadConfig(options.configPath);
        try {
          await gateway.openDashboard(config.gateway);
        } catch (error) {
          json(response, 503, { error: (error as Error).message });
          return;
        }
        json(response, 200, await readStatus());
        return;
      }

      json(response, 404, { error: "not found" });
    } catch (error) {
      json(
        response,
        error instanceof ControlInputError ||
          error instanceof SyntaxError ||
          error instanceof URIError
          ? 400
          : 500,
        {
        error: (error as Error).message,
        },
      );
    }
  });
  if (ownsThreadCatalog) {
    server.once("close", () => {
      void threadCatalog.close();
    });
  }
  return server;
}

export async function runControlServer(options: ControlServerOptions): Promise<void> {
  const host = options.host ?? DEFAULT_CONTROL_HOST;
  const port = options.port ?? DEFAULT_CONTROL_PORT;
  const server = createControlServer({ ...options, host, port });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  process.stdout.write(`[codex-router] control API listening on http://${host}:${port}\n`);

  await new Promise<void>((resolve) => {
    const parentPid = Number.parseInt(process.env.CODEX_ROUTER_CONTROL_PARENT_PID ?? "", 10);
    const parentMonitor = Number.isInteger(parentPid) && parentPid > 1
      ? setInterval(() => {
          try {
            process.kill(parentPid, 0);
          } catch {
            close();
          }
        }, 2_000)
      : undefined;
    parentMonitor?.unref();
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      if (parentMonitor) clearInterval(parentMonitor);
      server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

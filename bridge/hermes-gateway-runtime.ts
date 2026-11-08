import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { dialHerdr, type SockHandle } from "./dial.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  HermesGatewayDeliveryError,
  HermesGatewaySender,
  type HermesGatewayRpc,
  type HermesGatewaySenderDeps,
} from "./hermes-gateway.ts";
import { HermesTranscriptSource } from "./journal/hermes.ts";

const CONTROL_PROTOCOL = 1;
const WS_PROTOCOL = "hermes-gateway-v1";
const TICKET_PROTOCOL_PREFIX = "hermes-gateway-ticket.";
const CONTROL_TIMEOUT_MS = 2_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_CONTROL_BYTES = 256 * 1024;

function asRecord(value: JsonValue | undefined): JsonObject | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON was decoded at the control/WebSocket boundary; this selects its object variant.
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- field selection from a decoded JSON object is the boundary guard.
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canonical(value: string): Promise<string> {
  return realpath(value);
}

async function controlSocketPath(home: string): Promise<string> {
  if (process.platform === "win32") throw new Error("Hermes gateway control attachment is not available on Windows");
  const direct = join(home, "gateway.sock");
  try {
    const info = await lstat(direct);
    if (info.isSymbolicLink() || !info.isSocket()) throw new Error("Hermes gateway socket is not a local socket");
    if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error("Hermes gateway socket belongs to another user");
    return direct;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const pointer = join(home, "gateway.sock.path");
  const pointerInfo = await lstat(pointer);
  if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink()) throw new Error("Invalid Hermes gateway pointer file");
  if (process.getuid !== undefined && pointerInfo.uid !== process.getuid()) {
    throw new Error("Hermes gateway pointer belongs to another user");
  }
  const target = (await readFile(pointer, "utf8")).trim();
  if (!target.startsWith("/") || target.includes("\n")) throw new Error("Invalid Hermes gateway pointer target");
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink() || !targetInfo.isSocket() || (process.getuid !== undefined && targetInfo.uid !== process.getuid())) {
    throw new Error("Unsafe Hermes gateway socket target");
  }
  return target;
}

async function controlQuery(home: string, verb: string, params?: JsonObject): Promise<JsonObject> {
  const socketPath = await controlSocketPath(home);
  const id = crypto.randomUUID();
  const envelope: JsonObject = { protocol: CONTROL_PROTOCOL, id, verb };
  if (params !== undefined) envelope.params = params;
  const wire = JSON.stringify(envelope) + "\n";

  return new Promise<JsonObject>((resolve, reject) => {
    let socket: SockHandle | null = null;
    let cancelDial: (() => void) | null = null;
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`Hermes gateway ${verb} timed out`)), CONTROL_TIMEOUT_MS);
    const finish = (error?: Error, value?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket === null) cancelDial?.();
      socket?.end();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    void dialHerdr(socketPath, {
      onDial(cancel) { cancelDial = cancel; },
      open(handle) {
        socket = handle;
        handle.write(wire);
        handle.flush();
      },
      data(_handle, chunk) {
        buffer += new TextDecoder().decode(chunk, { stream: true });
        if (buffer.length > MAX_CONTROL_BYTES) return finish(new Error("Hermes gateway control answer too large"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          // SAFETY: JSON.parse returns only JSON-representable values for this control frame.
          const decoded = JSON.parse(buffer.slice(0, newline)) as JsonValue;
          const response = asRecord(decoded);
          if (response === null || response.id !== id || response.ok !== true) {
            return finish(new Error(asString(response?.error) ?? "Hermes gateway control request refused"));
          }
          const result = asRecord(response.result);
          if (result === null) return finish(new Error("Hermes gateway control answer is invalid"));
          finish(undefined, result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid Hermes gateway control JSON"));
        }
      },
      error(_handle, error) { finish(error); },
      close() { if (!settled) finish(new Error("Hermes gateway control socket closed")); },
    }).catch((error) => finish(error instanceof Error ? error : new Error("Hermes gateway control dial failed")));
  });
}

function controlHomes(profileHome: string): string[] {
  const parent = dirname(profileHome);
  return basename(parent) === "profiles" ? [profileHome, dirname(parent)] : [profileHome];
}

async function discover(profileHome: string): Promise<{ controlHome: string; identity: JsonObject }> {
  const wanted = await canonical(profileHome);
  let lastError: Error | null = null;
  for (const home of controlHomes(wanted)) {
    try {
      const identity = await controlQuery(home, "identify");
      const served = Array.isArray(identity.served_profiles) ? identity.served_profiles : [];
      const names = served.map((item) => asString(item)).filter((item): item is string => item !== null);
      const canonicalServed = await Promise.all(names.map(async (item) => canonical(item).catch(() => "")));
      if (identity.runtime_protocol === 1 && canonicalServed.includes(wanted)) return { controlHome: home, identity };
      lastError = new Error("Hermes gateway does not serve the requested profile");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Hermes gateway discovery failed");
    }
  }
  throw lastError ?? new Error("Hermes gateway unavailable");
}

function wsUrl(apiOrigin: string): string {
  const parsed = new URL(apiOrigin);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    throw new Error("Hermes gateway API origin is not loopback");
  }
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/api/ws";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

class CanonicalWebSocketRpc implements HermesGatewayRpc {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve(value: JsonValue): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- WebSocket MessageEvent data is a transport union; the gateway contract sends text frames.
      if (typeof event.data === "string") this.receive(event.data);
    });
    socket.addEventListener("close", () => this.failAll(new HermesGatewayDeliveryError("Hermes gateway disconnected", true)));
    socket.addEventListener("error", () => this.failAll(new HermesGatewayDeliveryError("Hermes gateway WebSocket failed", true)));
  }

  static connect(url: string, ticket: string): Promise<CanonicalWebSocketRpc> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, [WS_PROTOCOL, TICKET_PROTOCOL_PREFIX + ticket]);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Hermes gateway WebSocket timed out"));
      }, CONTROL_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        if (socket.protocol !== WS_PROTOCOL) {
          socket.close();
          reject(new Error("Hermes gateway WebSocket protocol mismatch"));
          return;
        }
        resolve(new CanonicalWebSocketRpc(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Hermes gateway WebSocket connection failed"));
      }, { once: true });
    });
  }

  call(method: string, params: JsonObject): Promise<JsonValue> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HermesGatewayDeliveryError("Hermes gateway is closed", false));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesGatewayDeliveryError(`Hermes gateway ${method} timed out`, true));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HermesGatewayDeliveryError(error instanceof Error ? error.message : "Hermes gateway write failed", false));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.failAll(new HermesGatewayDeliveryError("Hermes gateway client closed", true));
  }

  private receive(raw: string): void {
    let frame: JsonObject | null = null;
    try {
      // SAFETY: JSON.parse returns only JSON-representable values for this WebSocket text frame.
      frame = asRecord(JSON.parse(raw) as JsonValue);
    } catch { return; }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoded JSON-RPC ids are selected at this boundary; method-only frames are events.
    if (frame === null || typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    const error = asRecord(frame.error);
    if (error !== null) {
      pending.reject(new HermesGatewayDeliveryError(asString(error.message) ?? `Hermes gateway ${pending.method} refused`, false));
    } else {
      pending.resolve(frame.result ?? {});
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function connectCanonical(profileHome: string): Promise<HermesGatewayRpc> {
  const { controlHome, identity } = await discover(profileHome);
  const instanceId = asString(identity.instance_id);
  const apiOrigin = asString(identity.api_origin);
  if (instanceId === null || apiOrigin === null) throw new Error("Hermes gateway identity is incomplete");
  const grant = await controlQuery(controlHome, "session-ticket", {
    profile_id: await canonical(profileHome),
    instance_id: instanceId,
    purpose: "interactive",
    scope: "profile",
    restart_wait: "refuse",
  });
  if (grant.instance_id !== instanceId || grant.runtime_protocol !== 1 || grant.profile_id !== await canonical(profileHome)) {
    throw new Error("Hermes gateway ticket identity mismatch");
  }
  const ticket = asString(grant.ticket);
  if (ticket === null) throw new Error("Hermes gateway did not mint a ticket");
  return CanonicalWebSocketRpc.connect(wsUrl(apiOrigin), ticket);
}

export function createHermesGatewaySender(roots: string | readonly string[], overrides: Partial<HermesGatewaySenderDeps> = {}): HermesGatewaySender {
  const source = new HermesTranscriptSource(roots);
  return new HermesGatewaySender({
    resolveProfile: (sessionId) => source.profileHome(sessionId),
    connect: connectCanonical,
    ...overrides,
  });
}

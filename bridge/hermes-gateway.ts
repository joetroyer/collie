import type { AgentSessionRef } from "./journal/types.ts";
import type { JsonObject, JsonValue } from "./json.ts";

const HERMES_SESSION_ID = /^(?:\d{8}_\d{6}_[A-Za-z0-9]+|local-[a-f0-9]{64})$/u;

export interface HermesGatewayPane {
  readonly agent: string;
  readonly agentSession?: AgentSessionRef;
}

export function hermesGatewayCandidate(pane: HermesGatewayPane): { sessionId: string } | null {
  const ref = pane.agentSession;
  if (pane.agent !== "hermes" || ref?.kind !== "id" || !HERMES_SESSION_ID.test(ref.value)) return null;
  return { sessionId: ref.value };
}

export interface HermesGatewayRpc {
  call(method: string, params: JsonObject): Promise<JsonValue>;
  close(): void;
}

export class HermesGatewayDeliveryError extends Error {
  constructor(message: string, readonly mayHaveSent: boolean) {
    super(message);
    this.name = "HermesGatewayDeliveryError";
  }
}

export interface HermesGatewaySenderDeps {
  resolveProfile(sessionId: string): Promise<string | null>;
  connect(profileHome: string): Promise<HermesGatewayRpc>;
}

export interface HermesGatewaySendRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly text: string;
  readonly mode: "send" | "steer";
}

export type HermesGatewaySendResult =
  | { readonly kind: "sent"; readonly queued: boolean }
  | { readonly kind: "steered" }
  | { readonly kind: "fallback"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export async function tryHermesGatewaySend(args: {
  readonly pane: HermesGatewayPane;
  readonly requestId: string;
  readonly text: string;
  readonly mode: "send" | "steer";
  readonly send: (request: HermesGatewaySendRequest) => Promise<HermesGatewaySendResult>;
}): Promise<HermesGatewaySendResult | null> {
  const candidate = hermesGatewayCandidate(args.pane);
  // Slash commands, shell escapes, and @ file expansion are client-side Hermes UI features, not
  // model prompt text. Keep them on Collie's classic terminal protocol until the gateway exposes
  // canonical methods for those actions.
  if (candidate === null || /^[!/@]/u.test(args.text.trimStart())) return null;
  return args.send({ sessionId: candidate.sessionId, requestId: args.requestId, text: args.text, mode: args.mode });
}

function record(value: JsonValue): JsonObject | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON was decoded at the RPC boundary; this type guard selects the object variant.
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringField(value: JsonObject, name: string): string | null {
  const field = value[name];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- field selection from a decoded JSON object is the boundary guard.
  return typeof field === "string" ? field : null;
}

function numberField(value: JsonObject, name: string): number | null {
  const field = value[name];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- field selection from a decoded JSON object is the boundary guard.
  return typeof field === "number" ? field : null;
}

function boolField(value: JsonObject, name: string): boolean | null {
  const field = value[name];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- field selection from a decoded JSON object is the boundary guard.
  return typeof field === "boolean" ? field : null;
}

/**
 * One canonical send into Hermes' resident session authority.
 *
 * Failures before a prompt/control RPC are safe to hand to Collie's classic screen protocol. Once a
 * prompt/control frame may have left, this method never asks the caller to fall back: typing the same
 * text into the terminal could duplicate work whose acknowledgement was lost.
 */
export class HermesGatewaySender {
  constructor(private readonly deps: HermesGatewaySenderDeps) {}

  async send(request: HermesGatewaySendRequest): Promise<HermesGatewaySendResult> {
    const profileHome = await this.deps.resolveProfile(request.sessionId).catch(() => null);
    if (profileHome === null) return { kind: "fallback", reason: "session_profile_not_found" };

    let rpc: HermesGatewayRpc;
    try {
      rpc = await this.deps.connect(profileHome);
      const described = record(await rpc.call("runtime.describe", {}));
      if (described === null || stringField(described, "profile_id") !== profileHome) {
        rpc.close();
        return { kind: "fallback", reason: "gateway_identity_mismatch" };
      }
    } catch {
      return { kind: "fallback", reason: "gateway_attach_failed" };
    }

    try {
      let snapshot: JsonObject;
      try {
        const resumed = record(await rpc.call("session.resume", {
          session_id: request.sessionId,
          source: "tui",
          omit_messages: true,
        }));
        if (resumed === null) return { kind: "fallback", reason: "gateway_resume_invalid" };
        snapshot = resumed;
      } catch {
        return { kind: "fallback", reason: "gateway_attach_failed" };
      }

      const runtimeSessionId = stringField(snapshot, "session_id");
      const running = boolField(snapshot, "running");
      const generation = numberField(snapshot, "execution_generation");
      if (runtimeSessionId === null || running === null || generation === null) {
        return { kind: "fallback", reason: "gateway_resume_invalid" };
      }

      if (running && request.mode === "steer") {
        const redirected = await this.deliveryRpc(rpc, "session.redirect", {
          session_id: runtimeSessionId,
          text: request.text,
          execution_generation: generation,
        });
        if (redirected.kind === "unknown") return redirected;
        const correction = record(redirected.value);
        const status = correction === null ? null : stringField(correction, "status");
        if (status === "redirected" || status === "queued") return { kind: "steered" };
        if (status !== "rejected" || correction?.delivered !== false) {
          return { kind: "unknown", reason: "redirect_outcome_unknown" };
        }
        return this.submit(rpc, runtimeSessionId, request, true);
      }

      return this.submit(rpc, runtimeSessionId, request, running);
    } finally {
      rpc.close();
    }
  }

  private async submit(
    rpc: HermesGatewayRpc,
    runtimeSessionId: string,
    request: HermesGatewaySendRequest,
    queued: boolean,
  ): Promise<HermesGatewaySendResult> {
    const submitted = await this.deliveryRpc(rpc, "prompt.submit", {
      session_id: runtimeSessionId,
      text: request.text,
      submission_id: request.requestId,
      input_id: request.requestId,
      queued,
    });
    if (submitted.kind === "unknown") return submitted;
    const receipt = record(submitted.value);
    const status = receipt === null ? null : stringField(receipt, "status");
    if (status !== "queued" && status !== "started" && status !== "terminal") {
      return { kind: "unknown", reason: "submit_outcome_unknown" };
    }
    return { kind: "sent", queued: status === "queued" || queued };
  }

  private async deliveryRpc(
    rpc: HermesGatewayRpc,
    method: string,
    params: JsonObject,
  ): Promise<{ readonly kind: "ok"; readonly value: JsonValue } | { readonly kind: "unknown"; readonly reason: string }> {
    try {
      return { kind: "ok", value: await rpc.call(method, params) };
    } catch (error) {
      // A received, explicit refusal can set mayHaveSent=false. Transport implementations default to
      // the conservative direction for delivery RPCs: a lost answer means the write may have landed.
      const reason = error instanceof Error && error.message ? error.message : "gateway_request_failed";
      return { kind: "unknown", reason };
    }
  }
}

import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "./json.ts";

import {
  HermesGatewayDeliveryError,
  HermesGatewaySender,
  hermesGatewayCandidate,
  tryHermesGatewaySend,
  type HermesGatewayRpc,
  type HermesGatewaySendRequest,
} from "./hermes-gateway.ts";

const SID = "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Call = { method: string; params: JsonObject };

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test fixtures deliberately map each RPC method to its canned JSON answer or thrown error.
function rpc(replies: Record<string, JsonValue | Error>) {
  const calls: Call[] = [];
  const client: HermesGatewayRpc = {
    async call(method, params) {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`no reply for ${method}`);
      return reply;
    },
    close() {},
  };
  return { client, calls };
}

function sender(client: HermesGatewayRpc, profileHome = "/Users/test/.hermes") {
  return new HermesGatewaySender({
    resolveProfile: async (sessionId) => (sessionId === SID ? profileHome : null),
    connect: async (home) => {
      expect(home).toBe(profileHome);
      return client;
    },
  });
}

const described = {
  instance_id: "gateway-1",
  profile_id: "/Users/test/.hermes",
  authority_epoch: 4,
  capabilities: ["session-authority-v1"],
};

function resumed(running: boolean, generation = 7) {
  return {
    session_id: SID,
    stored_session_id: SID,
    running,
    execution_generation: generation,
    authority_epoch: 4,
    info: { desktop_protocol: "hermes-gateway-v1", profile_id: "/Users/test/.hermes" },
  };
}

describe("Hermes canonical gateway detection", () => {
  test("selects a Hermes pane with a canonical session id", () => {
    expect(hermesGatewayCandidate({ agent: "hermes", agentSession: { kind: "id", value: SID } })).toEqual({ sessionId: SID });
  });

  test("leaves classic/screen fallback in place without a usable session identity", () => {
    expect(hermesGatewayCandidate({ agent: "hermes" })).toBeNull();
    expect(hermesGatewayCandidate({ agent: "hermes", agentSession: { kind: "path", value: "/tmp/session" } })).toBeNull();
    expect(hermesGatewayCandidate({ agent: "claude", agentSession: { kind: "id", value: SID } })).toBeNull();
  });
});

describe("Hermes gateway routing guard", () => {
  test("handles ordinary Hermes prompt text and preserves the classic path for commands", async () => {
    const seen: HermesGatewaySendRequest[] = [];
    const send = async (request: HermesGatewaySendRequest) => {
      seen.push(request);
      return { kind: "sent", queued: false } as const;
    };
    const pane = { agent: "hermes", agentSession: { kind: "id", value: SID } as const };

    expect(await tryHermesGatewaySend({ pane, requestId: "route-1", text: "run tests", mode: "send", send })).toEqual({
      kind: "sent",
      queued: false,
    });
    expect(seen).toEqual([{ sessionId: SID, requestId: "route-1", text: "run tests", mode: "send" }]);

    expect(await tryHermesGatewaySend({ pane, requestId: "route-2", text: "/help", mode: "send", send })).toBeNull();
    expect(await tryHermesGatewaySend({ pane, requestId: "route-3", text: "!pwd", mode: "send", send })).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

describe("Hermes canonical gateway send", () => {
  test("attaches, resumes the stored session, and submits an idle prompt", async () => {
    const { client, calls } = rpc({
      "runtime.describe": described,
      "session.resume": resumed(false),
      "prompt.submit": {
        admission_id: "a1",
        ref: { profile_id: described.profile_id, session_id: SID },
        sequence: 1,
        status: "started",
        outcome: null,
        authority_epoch: 4,
        execution_generation: 8,
      },
    });

    const result = await sender(client).send({ sessionId: SID, requestId: "phone-1", text: "inspect this", mode: "send" });

    expect(result).toEqual({ kind: "sent", queued: false });
    expect(calls).toEqual([
      { method: "runtime.describe", params: {} },
      { method: "session.resume", params: { session_id: SID, source: "tui", omit_messages: true } },
      {
        method: "prompt.submit",
        params: { session_id: SID, text: "inspect this", submission_id: "phone-1", input_id: "phone-1", queued: false },
      },
    ]);
  });

  test("queues a normal prompt when the resumed session is busy", async () => {
    const { client, calls } = rpc({
      "runtime.describe": described,
      "session.resume": resumed(true),
      "prompt.submit": {
        admission_id: "a2",
        ref: { profile_id: described.profile_id, session_id: SID },
        sequence: 2,
        status: "queued",
        outcome: null,
        authority_epoch: 4,
        execution_generation: null,
      },
    });

    expect(await sender(client).send({ sessionId: SID, requestId: "phone-2", text: "then test", mode: "send" })).toEqual({
      kind: "sent",
      queued: true,
    });
    expect(calls.at(-1)).toEqual({
      method: "prompt.submit",
      params: { session_id: SID, text: "then test", submission_id: "phone-2", input_id: "phone-2", queued: true },
    });
  });

  test("redirects an explicit steer into the active execution generation", async () => {
    const { client, calls } = rpc({
      "runtime.describe": described,
      "session.resume": resumed(true, 11),
      "session.redirect": { status: "redirected", text: "focus on tests", execution_generation: 11, authority_epoch: 4 },
    });

    expect(await sender(client).send({ sessionId: SID, requestId: "phone-3", text: "focus on tests", mode: "steer" })).toEqual({
      kind: "steered",
    });
    expect(calls.at(-1)).toEqual({
      method: "session.redirect",
      params: { session_id: SID, text: "focus on tests", execution_generation: 11 },
    });
  });

  test("queues an explicit steer only when redirect proves it delivered nothing", async () => {
    const { client, calls } = rpc({
      "runtime.describe": described,
      "session.resume": resumed(true, 12),
      "session.redirect": { status: "rejected", text: "use the smaller patch", execution_generation: 12, authority_epoch: 4, delivered: false },
      "prompt.submit": {
        admission_id: "a4",
        ref: { profile_id: described.profile_id, session_id: SID },
        sequence: 4,
        status: "queued",
        outcome: null,
        authority_epoch: 4,
        execution_generation: null,
      },
    });

    expect(await sender(client).send({ sessionId: SID, requestId: "phone-4", text: "use the smaller patch", mode: "steer" })).toEqual({
      kind: "sent",
      queued: true,
    });
    expect(calls.map((call) => call.method)).toEqual(["runtime.describe", "session.resume", "session.redirect", "prompt.submit"]);
  });

  test("falls back before submission on discovery, attach, or resume failures", async () => {
    const noProfile = new HermesGatewaySender({ resolveProfile: async () => null, connect: async () => { throw new Error("must not connect"); } });
    expect(await noProfile.send({ sessionId: SID, requestId: "f1", text: "hello", mode: "send" })).toEqual({ kind: "fallback", reason: "session_profile_not_found" });

    const badResume = rpc({ "runtime.describe": described, "session.resume": new Error("not found") });
    expect(await sender(badResume.client).send({ sessionId: SID, requestId: "f2", text: "hello", mode: "send" })).toEqual({ kind: "fallback", reason: "gateway_attach_failed" });
  });

  test("never screen-fallbacks after a submission may have left", async () => {
    const { client } = rpc({
      "runtime.describe": described,
      "session.resume": resumed(false),
      "prompt.submit": new HermesGatewayDeliveryError("socket closed after write", true),
    });

    expect(await sender(client).send({ sessionId: SID, requestId: "f3", text: "do it once", mode: "send" })).toEqual({
      kind: "unknown",
      reason: "socket closed after write",
    });
  });
});

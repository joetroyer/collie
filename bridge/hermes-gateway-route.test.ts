import { describe, expect, test } from "bun:test";

import { AuditLog } from "./audit.ts";
import type { JsonValue } from "./json.ts";
import { HermesGatewaySender, type HermesGatewayRpc } from "./hermes-gateway.ts";
import { replyThroughProtocol, type ReplySendContext } from "./server.ts";

const SID = "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function context() {
  return { audit: new AuditLog(() => undefined), device: "phone", redact: false, acceptEncoding: null };
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test fixtures deliberately map each RPC method to its canned JSON answer or thrown error.
function gateway(replies: Record<string, JsonValue | Error>) {
  const calls: string[] = [];
  const client: HermesGatewayRpc = {
    async call(method) {
      calls.push(method);
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`no reply for ${method}`);
      return reply;
    },
    close() {},
  };
  return {
    calls,
    sender: new HermesGatewaySender({ resolveProfile: async () => "/profiles/default", connect: async () => client }),
  };
}

function sendContext(sender: HermesGatewaySender, fallback: { calls: number }): ReplySendContext {
  return {
    // SAFETY: replyThroughProtocol calls only handle() on this protocol fake.
    protocol: {
      handle: async () => {
        fallback.calls += 1;
        return { offers: [] };
      },
    } as never,
    harnessOf: () => "hermes",
    paneOf: () => ({ agent: "hermes", agentSession: { kind: "id", value: SID } }),
    hermesGateway: sender,
  };
}

const described = { profile_id: "/profiles/default", instance_id: "owner-1" };
const resumed = { session_id: SID, running: false, execution_generation: 1 };

describe("Hermes reply route", () => {
  test("uses the canonical gateway and does not touch the screen protocol", async () => {
    const fake = gateway({
      "runtime.describe": described,
      "session.resume": resumed,
      "prompt.submit": { status: "started" },
    });
    const fallback = { calls: 0 };

    const response = await replyThroughProtocol(
      sendContext(fake.sender, fallback),
      "%1",
      "main",
      { id: "hermes-route-0001", text: "run focused tests", mode: "send" },
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      send: { receipt: { outcome: "sent", acknowledged: "hermes-route-0001", profileId: "hermes-gateway-v1" } },
    });
    expect(fake.calls).toEqual(["runtime.describe", "session.resume", "prompt.submit"]);
    expect(fallback.calls).toBe(0);
  });

  test("keeps the classic screen protocol when canonical attach fails", async () => {
    const fake = gateway({ "runtime.describe": new Error("owner absent") });
    const fallback = { calls: 0 };

    const response = await replyThroughProtocol(
      sendContext(fake.sender, fallback),
      "%1",
      "main",
      { id: "hermes-route-0002", text: "run focused tests", mode: "send" },
      context(),
    );

    expect(response.status).toBe(200);
    expect(fallback.calls).toBe(1);
  });

  test("does not screen-fallback after canonical submission has an unknown outcome", async () => {
    const fake = gateway({
      "runtime.describe": described,
      "session.resume": resumed,
      "prompt.submit": new Error("lost acknowledgement"),
    });
    const fallback = { calls: 0 };

    const response = await replyThroughProtocol(
      sendContext(fake.sender, fallback),
      "%1",
      "main",
      { id: "hermes-route-0003", text: "do this once", mode: "send" },
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, textDelivered: true, send: { receipt: { outcome: "unknown" } } });
    expect(fallback.calls).toBe(0);
  });
});

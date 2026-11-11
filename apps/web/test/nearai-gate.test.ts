/**
 * The NEAR AI relay's gate and caps (src/lib/server/nearai-gate.ts).
 *
 *   pnpm --filter @chair/web test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  checkGate,
  checkSignatureQuery,
  DEFAULT_RELAY_TOKENS,
  ForwardBudget,
  maskKey,
  MeetingForwarder,
  NEARAI_API_BASE,
  networkOf,
  openMeetingFrom,
  parseRelayTokens,
  sha256Hex,
  signatureUrl,
  type UpstreamReply,
  WindowLimiter,
} from "../src/lib/server/nearai-gate";

/** A real request the token built (meeting 1 of `pnpm courier:live`) and the hash its record holds. */
const live = resolve(import.meta.dirname, "../../../results/courier-live-2026-11-11");
const REQUEST = readFileSync(resolve(live, "request.json"));
const RECORD = JSON.parse(readFileSync(resolve(live, "meeting.json"), "utf8")) as { meeting: number; request_sha256: string };

const status = (open: number | null) => ({ open_meeting: open });
const record = (n: number, over: Partial<{ status: string; request_sha256: string | null }> = {}) => ({
  number: n,
  status: "requested",
  request_sha256: RECORD.request_sha256,
  ...over,
});
const OPEN = openMeetingFrom(status(4), record(4))!;

describe("tokens", () => {
  it("defaults to the site's network token", () => {
    assert.deepEqual(parseRelayTokens(undefined, "testnet"), ["token5.chair-dev.testnet"]);
    assert.deepEqual(parseRelayTokens("  ", "mainnet"), ["token.thechair.near"]);
    assert.deepEqual(DEFAULT_RELAY_TOKENS, { testnet: "token5.chair-dev.testnet", mainnet: "token.thechair.near" });
  });

  it("reads a comma list, both networks, without duplicates", () => {
    assert.deepEqual(parseRelayTokens("token5.chair-dev.testnet, token.thechair.near,token5.chair-dev.testnet", "testnet"), [
      "token5.chair-dev.testnet",
      "token.thechair.near",
    ]);
  });

  it("refuses anything that is not a .testnet or .near account", () => {
    for (const bad of ["Token.near", "token..near", "-x.near", "token.thechair.near/", "a b.near", "token.thechair.eth", "x"]) {
      assert.throws(() => parseRelayTokens(bad, "testnet"), /CHAIR_RELAY_TOKENS/, bad);
    }
  });

  it("infers the network from the suffix", () => {
    assert.equal(networkOf("token5.chair-dev.testnet"), "testnet");
    assert.equal(networkOf("token.thechair.near"), "mainnet");
    assert.equal(networkOf("token.thechair.nearx"), null);
  });
});

describe("open meeting", () => {
  it("is the status's open_meeting whose record is still requested", () => {
    assert.deepEqual(OPEN, { meeting: 4, requestSha256: RECORD.request_sha256 });
  });

  it("is none when nothing is open", () => {
    assert.equal(openMeetingFrom(status(null), record(4)), null);
    assert.equal(openMeetingFrom(status(4), null), null);
    assert.equal(openMeetingFrom(null, record(4)), null);
  });

  it("is none once the meeting is held or lapsed", () => {
    assert.equal(openMeetingFrom(status(4), record(4, { status: "held" })), null);
    assert.equal(openMeetingFrom(status(4), record(4, { status: "lapsed" })), null);
  });

  it("is none for another meeting's record or a missing hash", () => {
    assert.equal(openMeetingFrom(status(5), record(4)), null);
    assert.equal(openMeetingFrom(status(4), record(4, { request_sha256: null })), null);
    assert.equal(openMeetingFrom(status(4), record(4, { request_sha256: "ABC" })), null);
  });
});

describe("gate", () => {
  it("passes the exact request bytes the token hashed", () => {
    assert.equal(sha256Hex(REQUEST), RECORD.request_sha256);
    assert.deepEqual(checkGate(sha256Hex(REQUEST), OPEN), { ok: true, meeting: 4 });
  });

  it("refuses any other bytes: one space, reordered keys, a re-serialisation", () => {
    const text = REQUEST.toString("utf8");
    const variants = [
      Buffer.concat([REQUEST, Buffer.from(" ")]),
      Buffer.from(`${text.slice(0, -1)} }`),
      Buffer.from(JSON.stringify(JSON.parse(text), null, 1)),
      Buffer.from(JSON.stringify({ ...JSON.parse(text), temperature: 1 })),
      Buffer.from(JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] })),
      Buffer.alloc(0),
    ];
    for (const v of variants) {
      const g = checkGate(sha256Hex(v), OPEN);
      assert.equal(g.ok, false);
      if (!g.ok) {
        assert.equal(g.status, 403);
        assert.equal(g.code, "not_the_meeting_request");
      }
    }
  });

  it("refuses even the right bytes when no meeting is open", () => {
    const g = checkGate(sha256Hex(REQUEST), null);
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.code, "no_open_meeting");
  });

  it("refuses the request of a meeting that has since been held", () => {
    const held = openMeetingFrom(status(4), record(4, { status: "held" }));
    assert.equal(checkGate(sha256Hex(REQUEST), held).ok, false);
  });
});

describe("spend cap", () => {
  it("allows N forwards per (token, meeting), then none", () => {
    const b = new ForwardBudget(2);
    assert.equal(b.take("t.testnet", 4), true);
    assert.equal(b.take("t.testnet", 4), true);
    assert.equal(b.take("t.testnet", 4), false);
    assert.equal(b.spent("t.testnet", 4), 2);
    assert.equal(b.take("t.testnet", 5), true, "a new meeting has its own budget");
    assert.equal(b.take("u.near", 4), true, "another token has its own budget");
  });
});

const reply = (status: number, body = `{"id":"chatcmpl-${status}"}`): UpstreamReply => ({
  status,
  body: new Uint8Array(Buffer.from(body)),
  contentType: "application/json",
});

describe("forwarder", () => {
  it("fetches a 200 once and replays it without spending the budget", async () => {
    const f = new MeetingForwarder(new ForwardBudget(2));
    let sent = 0;
    const send = async () => (sent++, reply(200));
    const a = await f.forward("t.testnet", 4, send);
    const b = await f.forward("t.testnet", 4, send);
    const c = await f.forward("t.testnet", 4, send);
    assert.equal(sent, 1);
    assert.ok(a.ok && b.ok && c.ok);
    if (a.ok && b.ok) {
      assert.equal(a.how, "forwarded");
      assert.equal(b.how, "replayed");
      assert.deepEqual(b.reply.body, a.reply.body, "the replay is the same bytes");
    }
    assert.equal(f.budget.spent("t.testnet", 4), 1);
  });

  it("does not keep a failure, and stops at the cap", async () => {
    const f = new MeetingForwarder(new ForwardBudget(2));
    let sent = 0;
    const send = async () => (sent++, reply(500, "busy"));
    const a = await f.forward("t.testnet", 4, send);
    const b = await f.forward("t.testnet", 4, send);
    const c = await f.forward("t.testnet", 4, send);
    assert.ok(a.ok && a.reply.status === 500 && a.how === "forwarded");
    assert.ok(b.ok && b.how === "forwarded");
    assert.ok(!c.ok && c.code === "forward_cap");
    assert.equal(sent, 2);
  });

  it("a transport failure spends a forward too", async () => {
    const f = new MeetingForwarder(new ForwardBudget(1));
    await assert.rejects(
      f.forward("t.testnet", 4, async () => {
        throw new Error("timeout");
      }),
    );
    const again = await f.forward("t.testnet", 4, async () => reply(200));
    assert.ok(!again.ok);
  });

  it("a caller that arrives mid-fetch waits for it instead of fetching again", async () => {
    const f = new MeetingForwarder(new ForwardBudget(2));
    let sent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = async () => {
      sent++;
      await gate;
      return reply(200);
    };
    const first = f.forward("t.testnet", 4, send);
    const second = f.forward("t.testnet", 4, send);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(sent, 1);
    assert.ok(a.ok && a.how === "forwarded" && b.ok && b.how === "joined");
  });

  it("someone who copies the request first can't lock the courier out", async () => {
    const f = new MeetingForwarder(new ForwardBudget(2));
    const send = async () => reply(200);
    await f.forward("t.testnet", 4, send); // the copier
    await f.forward("t.testnet", 4, send); // again
    const courier = await f.forward("t.testnet", 4, send);
    assert.ok(courier.ok && courier.reply.status === 200);
  });
});

describe("rate limit", () => {
  it("allows max per window, then says how long to wait", () => {
    const l = new WindowLimiter(2, 60_000);
    assert.ok(l.take("ip", 0).ok);
    assert.ok(l.take("ip", 1_000).ok);
    const no = l.take("ip", 2_000);
    assert.ok(!no.ok && no.retryAfterS === 58);
    assert.ok(l.take("other", 2_000).ok);
    assert.ok(l.take("ip", 60_001).ok, "the window slides");
  });
});

describe("signature lookups", () => {
  it("accepts the courier's lookup and rebuilds the upstream URL", () => {
    const q = checkSignatureQuery("dbf921623ee14de5bff2ad71e1570d1f", "z-ai/glm-5.3-flash", "ecdsa");
    assert.ok(q.ok);
    if (q.ok) {
      assert.equal(
        signatureUrl(NEARAI_API_BASE, q),
        "https://cloud-api.near.ai/v1/signature/dbf921623ee14de5bff2ad71e1570d1f?model=z-ai%2Fglm-5.3-flash&signing_algo=ecdsa",
      );
    }
  });

  it("refuses other algorithms, missing models and path tricks", () => {
    assert.ok(!checkSignatureQuery("abc", "m", "ed25519").ok);
    assert.ok(!checkSignatureQuery("abc", "m", null).ok);
    assert.ok(!checkSignatureQuery("abc", null, "ecdsa").ok);
    assert.ok(!checkSignatureQuery("../models", "m", "ecdsa").ok);
    assert.ok(!checkSignatureQuery("a/b", "m", "ecdsa").ok);
    assert.ok(!checkSignatureQuery("abc", "m&x=1", "ecdsa").ok);
    assert.ok(!checkSignatureQuery("x".repeat(256), "m", "ecdsa").ok);
  });
});

describe("key masking", () => {
  const KEY = "sk-relay-0123456789abcdef";

  it("leaves a body without the key byte for byte", () => {
    const body = new Uint8Array(REQUEST);
    assert.equal(maskKey(body, KEY), body);
  });

  it("masks every copy of the key in an echoed error", () => {
    const echo = Buffer.from(`{"error":"Invalid API key Bearer ${KEY}","again":"${KEY}"}`);
    const out = Buffer.from(maskKey(new Uint8Array(echo), KEY)).toString("utf8");
    assert.ok(!out.includes(KEY));
    assert.equal(out, `{"error":"Invalid API key Bearer [redacted]","again":"[redacted]"}`);
  });
});

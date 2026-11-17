import {
  type ContractCall,
  type CustodyClient,
  CustodyRejectedError,
  type CustodyTx,
  PreBroadcastError,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import { createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import { type Address, type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { type Mock, describe, expect, it, vi } from "vitest";

import { createFireblocksExecutor } from "./fireblocksExecutor";

const VAULT = "0x00000000000000000000000000000000000000aa" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const SPENDER = "0x4444444444444444444444444444444444444444" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const CALL: ContractCall = {
  address: TARGET,
  abi: [{ type: "function", name: "act", inputs: [], outputs: [], stateMutability: "nonpayable" }],
  functionName: "act",
  args: [],
};
const claim = (subject: string) => ({ target: TARGET, action: "liquidation", subject });
const intentKey = (subject: string) => idempotencyKey({ chainId: 31337, ...claim(subject) });

/** A `CustodyClient` whose calls are spies, so a test can read what was asked of it. */
interface FakeClient extends CustodyClient {
  submit: Mock<CustodyClient["submit"]>;
  get: Mock<CustodyClient["get"]>;
  getByExternalId: Mock<CustodyClient["getByExternalId"]>;
}

type ClientScript = {
  submit?: CustodyClient["submit"];
  get?: CustodyClient["get"];
  getByExternalId?: CustodyClient["getByExternalId"];
};

/** A custodian that accepts everything and reports a hash on the first look, unless scripted. */
function fakeClient(script: ClientScript = {}): FakeClient {
  return {
    address: VAULT,
    submit: vi.fn(script.submit ?? (async () => ({ id: "fb-1" }))),
    get: vi.fn(
      script.get ??
        (async (): Promise<CustodyTx | null> => ({ id: "fb-1", status: "COMPLETED", txHash: HASH }))
    ),
    getByExternalId: vi.fn(script.getByExternalId ?? (async () => null)),
  };
}

/** What the chain says. `receipts` maps a hash to its mined status; anything else is unknown. */
function chain(
  opts: { receipts?: Record<string, "success" | "reverted">; allowance?: bigint } = {}
) {
  return {
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      const status = opts.receipts?.[hash];
      if (!status) throw new TransactionReceiptNotFoundError({ hash: hash as Hex });
      return { status, blockNumber: 1n };
    }),
    readContract: vi.fn(async () => opts.allowance ?? 0n),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => ({
      status: opts.receipts?.[hash] ?? "success",
      blockNumber: 1n,
    })),
  } as unknown as PublicClient;
}

function setup(
  over: {
    client?: FakeClient;
    publicClient?: PublicClient;
    assertCanBroadcast?: (action: string) => void;
    clock?: { t: number };
  } = {}
) {
  const clock = over.clock ?? { t: 1_700_000_000_000 };
  // One second per write, so one attempt is distinguishable from the next — see `tickingStore`'s
  // reasoning in `executor.test.ts`.
  const store = createMemoryStateStore(() => {
    clock.t += 1_000;
    return clock.t;
  });
  const client = over.client ?? fakeClient();
  const exec = createFireblocksExecutor({
    store,
    publicClient: over.publicClient ?? chain(),
    client,
    chainId: 31337,
    txReceiptTimeoutMs: 1000,
    poll: { intervalMs: 1, timeoutMs: 5 },
    assertCanBroadcast: over.assertCanBroadcast,
    logger: silentLogger,
    now: () => clock.t,
    graceMs: 60_000,
    sleep: async () => {
      clock.t += 1;
    },
  });
  return { exec, store, client, clock };
}

describe("createFireblocksExecutor", () => {
  it("is keyless: it sends from the vault and sequences no nonce", async () => {
    const { exec, store } = setup();

    expect(exec.mode).toBe("FIREBLOCKS");
    expect(exec.identity).toEqual({ from: VAULT, chainId: 31337 });

    await exec.commit(CALL, claim("p"));
    expect(store.get(intentKey("p"))?.nonce).toBeNull();
  });

  it("records the request's ref durably BEFORE asking the custodian, then the hash it reports", async () => {
    let refWhenAsked: string | null | undefined;
    let sentRef: string | undefined;
    const { exec, store } = setup({
      client: fakeClient({
        submit: async (req) => {
          refWhenAsked = store.get(intentKey("p"))?.custodyRef;
          sentRef = req.externalTxId;
          return { id: "fb-1" };
        },
      }),
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "broadcast", hash: HASH });
    // A crash between the write and the response must leave a row reconcile can ask about.
    expect(refWhenAsked).toBe(sentRef);
    expect(store.get(intentKey("p"))).toMatchObject({
      status: "submitted",
      txHash: HASH,
      custodyRef: sentRef,
    });
  });

  it("asks for a different ref on the next attempt at the same subject", async () => {
    const refs: string[] = [];
    const { exec, store } = setup({
      client: fakeClient({
        submit: async (req) => {
          refs.push(req.externalTxId);
          if (refs.length === 1) throw new CustodyRejectedError("policy says no");
          return { id: "fb-2" };
        },
      }),
    });

    await exec.commit(CALL, claim("p"));
    expect(store.get(intentKey("p"))?.status).toBe("failed");
    await exec.commit(CALL, claim("p"));

    // An intent id is reused when a failed row is revived, and a custodian refuses a repeated
    // externalTxId — so the second try would be refused outright if the ref came from the id alone.
    expect(refs).toHaveLength(2);
    expect(refs[1]).not.toBe(refs[0]);
  });

  it("settles a refusal as abandoned and frees the subject — nothing was created", async () => {
    const { exec, store } = setup({
      client: fakeClient({
        submit: async () => {
          throw new CustodyRejectedError("blocked by policy");
        },
      }),
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    expect(store.get(intentKey("p"))).toMatchObject({ status: "failed" });
    // Revivable: the next cycle may try again.
    expect(await store.recordIntent({ chainId: 31337, ...claim("p") })).toMatchObject({
      recorded: true,
    });
  });

  it("keeps the subject blocked when the answer to the request is lost", async () => {
    const { exec, store } = setup({
      client: fakeClient({
        submit: async () => {
          throw new Error("socket hang up");
        },
      }),
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    // The custodian may have accepted it: the row must stay live, not be freed for a second request.
    expect(store.get(intentKey("p"))).toMatchObject({ status: "submitted" });
    expect(store.get(intentKey("p"))?.custodyRef).not.toBeNull();
    expect(await exec.commit(CALL, claim("p"))).toMatchObject({ kind: "duplicate" });
  });

  it("keeps the intent live when the custodian reports no hash in time", async () => {
    const { exec, store } = setup({
      client: fakeClient({ get: async () => ({ id: "fb-1", status: "PENDING_AUTHORIZATION" }) }),
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    expect(out.kind === "aborted" && out.error).toMatch(/PENDING_AUTHORIZATION/);
    // Still approvable by a human at the custodian — so not failed, and not re-driven.
    expect(store.get(intentKey("p"))).toMatchObject({ status: "submitted" });
  });

  it("fails the intent when the custodian gives up before broadcasting", async () => {
    const { exec, store } = setup({
      client: fakeClient({
        get: async () => ({ id: "fb-1", status: "REJECTED", subStatus: "REJECTED_BY_POLICY" }),
      }),
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    expect(store.get(intentKey("p"))).toMatchObject({ status: "failed" });
  });

  it("asks nothing of the custodian once the gate is halted", async () => {
    const { exec, client, store } = setup({
      assertCanBroadcast: () => {
        throw new PreBroadcastError("risk gate is HALTED");
      },
    });

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    expect(client.submit).not.toHaveBeenCalled();
    expect(store.get(intentKey("p"))).toBeDefined();
  });

  it("returns duplicate for a live subject, without asking the custodian", async () => {
    const { exec, client, store } = setup();
    await store.recordIntent({ chainId: 31337, ...claim("p") });

    expect(await exec.commit(CALL, claim("p"))).toMatchObject({ kind: "duplicate" });
    expect(client.submit).not.toHaveBeenCalled();
  });

  describe("reconcile", () => {
    /** A request whose response was lost: the ref is durable, no hash ever came back. */
    async function lostResponse(over: ClientScript) {
      const ctx = setup({
        client: fakeClient({
          submit: async () => {
            throw new Error("socket hang up");
          },
          ...over,
        }),
      });
      await ctx.exec.commit(CALL, claim("p"));
      return ctx;
    }

    it("recovers the hash of a transaction the custodian did create", async () => {
      const ctx = await lostResponse({
        getByExternalId: async () => ({ id: "fb-1", status: "BROADCASTING", txHash: HASH }),
      });

      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "submitted", txHash: HASH });
    });

    it("then resolves it by receipt on the next pass", async () => {
      const ctx = setup({
        client: fakeClient({
          submit: async () => {
            throw new Error("socket hang up");
          },
          getByExternalId: async () => ({ id: "fb-1", status: "BROADCASTING", txHash: HASH }),
        }),
        publicClient: chain({ receipts: { [HASH]: "success" } }),
      });
      await ctx.exec.commit(CALL, claim("p"));

      await ctx.exec.reconcile();
      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "confirmed", txHash: HASH });
    });

    it("does not fail a request the custodian has not shown yet, inside the grace window", async () => {
      const ctx = await lostResponse({ getByExternalId: async () => null });

      await ctx.exec.reconcile();

      // Eventual consistency, or a request still in flight, would look exactly like this.
      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "submitted" });
    });

    it("fails a request the custodian never heard of, once the grace window has passed", async () => {
      const ctx = await lostResponse({ getByExternalId: async () => null });
      ctx.clock.t += 120_000;

      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "failed" });
    });

    it("keeps an intent live while the custodian is still working on it", async () => {
      const ctx = await lostResponse({
        getByExternalId: async () => ({ id: "fb-1", status: "PENDING_AUTHORIZATION" }),
      });
      ctx.clock.t += 120_000;

      await ctx.exec.reconcile();

      // Past the grace window, so only the custodian's answer can be what keeps it.
      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "submitted" });
    });

    it("fails an intent the custodian gave up on", async () => {
      const ctx = await lostResponse({
        getByExternalId: async () => ({ id: "fb-1", status: "CANCELLED" }),
      });

      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "failed" });
    });

    it("fails a broadcast the custodian later cancelled, when no receipt will ever come", async () => {
      const ctx = setup({
        client: fakeClient({
          getByExternalId: async () => ({ id: "fb-1", status: "CANCELLED", txHash: HASH }),
        }),
      });
      await ctx.exec.commit(CALL, claim("p")); // hash recorded, no receipt on chain

      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "failed", txHash: HASH });
    });

    it("trusts a receipt over the custodian's status", async () => {
      // `FAILED` for a transaction that mined and reverted — the receipt is the authority, and a
      // revert is a revert, not "abandoned".
      const ctx = setup({
        client: fakeClient({
          getByExternalId: async () => ({ id: "fb-1", status: "FAILED", txHash: HASH }),
        }),
        publicClient: chain({ receipts: { [HASH]: "success" } }),
      });
      await ctx.exec.commit(CALL, claim("p"));

      await ctx.exec.reconcile();

      expect(ctx.store.get(intentKey("p"))).toMatchObject({ status: "confirmed" });
    });

    it("does not ask the custodian about a row this process is still sending", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ctx = setup({
        client: fakeClient({
          submit: async () => {
            await gate;
            return { id: "fb-1" };
          },
          getByExternalId: async () => null,
        }),
      });

      const pending = ctx.exec.commit(CALL, claim("p"));
      await vi.waitFor(() => expect(ctx.client.submit).toHaveBeenCalled());
      ctx.clock.t += 120_000; // far past grace: only `isSending` is protecting it
      await ctx.exec.reconcile();
      expect(ctx.store.get(intentKey("p"))?.status).not.toBe("failed");

      release();
      await pending;
    });
  });

  describe("ensureAllowance", () => {
    it("is satisfied without a request when the spender can already pull", async () => {
      const { exec, client } = setup({ publicClient: chain({ allowance: 10n }) });

      expect(await exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 10n })).toEqual(
        { kind: "satisfied" }
      );
      expect(client.submit).not.toHaveBeenCalled();
    });

    it("approves through the custodian and records the intent confirmed", async () => {
      const { exec, client, store } = setup({ publicClient: chain({ allowance: 0n }) });

      expect(await exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 10n })).toEqual(
        { kind: "satisfied" }
      );

      expect(client.submit).toHaveBeenCalledOnce();
      const [req] = client.submit.mock.calls[0];
      expect(req.to).toBe(TOKEN);
      // approve(spender, maxUint256)
      expect(req.data.startsWith("0x095ea7b3")).toBe(true);
      expect(
        store.get(
          idempotencyKey({ chainId: 31337, target: TOKEN, action: "approval", subject: SPENDER })
        )
      ).toMatchObject({ status: "confirmed", txHash: HASH });
    });

    it("throws when the approval reverts, and fails the intent", async () => {
      const { exec, store } = setup({
        publicClient: chain({ allowance: 0n, receipts: { [HASH]: "reverted" } }),
      });

      await expect(
        exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 10n })
      ).rejects.toThrow(/reverted/);
      expect(
        store.get(
          idempotencyKey({ chainId: 31337, target: TOKEN, action: "approval", subject: SPENDER })
        )
      ).toMatchObject({ status: "failed" });
    });

    it("refuses to grant while the gate is halted, but still revokes", async () => {
      const { exec, client } = setup({
        publicClient: chain({ allowance: 5n }),
        assertCanBroadcast: () => {
          throw new PreBroadcastError("risk gate is HALTED");
        },
      });

      await expect(
        exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 10n })
      ).rejects.toThrow(/HALTED/);
      expect(client.submit).not.toHaveBeenCalled();

      await exec.revokeAllowance({ token: TOKEN, spender: SPENDER });
      expect(client.submit).toHaveBeenCalledOnce();
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { erc20Abi } from "@repo/abis";
import { readAllowance } from "@repo/chain";
import {
  type ContractCall,
  type CustodyClient,
  CustodyRejectedError,
  createNonceAllocator,
  createNonceLease,
  encodeCall,
  readCustodyTx,
  waitForCustodyHash,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { StateStore, TxIntent } from "@repo/persistence";
import { type Address, type Hex, type PublicClient, maxUint256 } from "viem";

import { createCrashSafety } from "./crashSafety";
import type { AllowanceResult, CommitResult, FireblocksExecutor, IntentClaim } from "./executor";
import { createChainReader } from "./liveness";

// The FIREBLOCKS arm of the execution seam: a custodian signs and broadcasts, so this process holds
// no key and sequences no nonce.
//
// What that changes against AUTO is the crash-safety anchor. AUTO signs locally, so the tx hash
// exists before anything reaches the chain and is recorded first; here the hash only exists once the
// custodian has broadcast, some time after it accepted the request. The anchor is instead the
// `custodyRef` — the `externalTxId` the request is made under — recorded *before* the request. After
// a crash or a lost response, "did you create the transaction for this ref?" has an exact answer,
// which is what reconcile asks (see `reconcilePending`'s `custody`).
//
//   claim → record custodyRef → submit → wait for hash → record hash → (engine waits the receipt)
//
// The two classes of failure mean different things and must not be conflated:
//
//   - The custodian *said no* (a 4xx on submit, or a terminal status with no hash): nothing was
//     created and nothing can land. The intent is failed on the spot and its subject is free.
//   - The answer was *lost* (a timeout, a 5xx, no hash within the budget): the custodian may still
//     send it. The intent stays live and reconcile resolves it by asking the custodian.

/** What a dispatch ended in, before the caller decides what a `sent` hash is for. */
type Dispatched =
  | { kind: "sent"; hash: Hex; intentId?: string }
  | Extract<CommitResult, { kind: "duplicate" | "aborted" }>;

export interface FireblocksExecutorDeps {
  store?: StateStore;
  publicClient: PublicClient;
  client: CustodyClient;
  chainId: number;
  /** Receipt-wait budget for approvals (matches the engine's action timeout). */
  txReceiptTimeoutMs: number;
  /**
   * How long to wait for the custodian to report a hash, and how often to ask. The budget has to
   * cover the custodian's own approval policy: a transaction waiting on a human approver has no hash
   * yet, and giving up on it early is an ambiguous outcome rather than a failure.
   */
  poll: { intervalMs: number; timeoutMs: number };
  /** Last word before a transaction is requested; throw `PreBroadcastError` to stop it. */
  assertCanBroadcast?: (action: string) => void;
  logger: Logger;
  /** Injectable clock and sleeper, so a test can age an intent or skip the poll wait. */
  now?: () => number;
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createFireblocksExecutor(deps: FireblocksExecutorDeps): FireblocksExecutor {
  const { store, publicClient, client, chainId, txReceiptTimeoutMs, poll, logger } = deps;
  const assertCanBroadcast = deps.assertCanBroadcast ?? (() => {});
  const identity = { from: client.address, chainId };

  const crash = createCrashSafety({
    store,
    // Required by the collaborator and never used: the custodian owns the nonce, so nothing here
    // reserves, reseeds or fences one. Reconcile reads no signer nonce either, because no custody
    // intent carries one.
    nonces: createNonceAllocator(createNonceLease(), identity.from),
    reader: createChainReader(publicClient),
    signer: identity.from,
    logger,
    now: deps.now,
    graceMs: deps.graceMs,
    custody: async (ref) => readCustodyTx(await client.getByExternalId(ref)),
  });

  /**
   * The key the request is made under. Unique per *attempt*, not per subject: an intent id is reused
   * when a terminal row is revived, and a custodian refuses a repeated `externalTxId`. The attempt
   * stamp is what makes the second try on the same subject a different request.
   */
  const custodyRefFor = (intentId: string | undefined, attemptAt: number | undefined): string =>
    intentId !== undefined && attemptAt !== undefined
      ? `v4bot-${createHash("sha256").update(`${intentId}|${attemptAt}`).digest("hex").slice(0, 40)}`
      : // No store, so no attempt to tell apart and nothing that will ever look this up.
        `v4bot-${randomUUID()}`;

  /**
   * Claim, ask the custodian to send `call`, and wait for the hash it reports. Every exit settles the
   * intent the way its evidence allows: a refusal fails it, anything ambiguous leaves it live.
   * `guard` is the broadcast guard; it runs twice, as AUTO's does — once before anything is written,
   * and once immediately before the request.
   */
  async function dispatch(
    call: ContractCall,
    claim: IntentClaim,
    guard?: () => void
  ): Promise<Dispatched> {
    const claimed = await crash.claim({ ...claim, chainId });
    if (!claimed.claimed) return { kind: "duplicate", existing: claimed.existing as TxIntent };
    const intentId = claimed.intentId;
    const custodyRef = custodyRefFor(intentId, claimed.attemptAt);
    const { to, data } = encodeCall(call);

    // Set only once the ref is durable. From then on the custodian may hold a transaction for this
    // row, and every write to it is bound to the ref so it lands on this attempt or not at all.
    let referenced = false;
    // Held for the whole dispatch so this process's own reconcile — the sibling engine's — does not
    // judge a row still being sent. Released in `finally`: a leaked id would be skipped by every
    // later reconcile and its subject blocked for good.
    if (intentId) crash.beginSend(intentId);
    try {
      guard?.();
      if (intentId && claimed.attemptAt !== undefined) {
        await crash.markCustody(intentId, custodyRef, claimed.attemptAt);
        referenced = true;
      }
      // Nothing is awaited between this check and the request.
      guard?.();

      let id: string;
      try {
        ({ id } = await client.submit({
          externalTxId: custodyRef,
          to,
          data,
          note: `${claim.action} ${claim.subject}`,
        }));
      } catch (error) {
        if (!(error instanceof CustodyRejectedError)) throw error;
        // The custodian refused outright — nothing exists, so the intent is over and its subject free.
        if (intentId) {
          await crash.transition(intentId, "failed", { error: error.message }, { custodyRef });
        }
        return { kind: "aborted", broadcastAttempted: false, error: error.message };
      }
      logger.info(`Custodian accepted ${claim.action} ${claim.subject} as ${id}`);

      const waited = await waitForCustodyHash(client, id, { ...poll, sleep: deps.sleep });
      if (waited.kind === "broadcast") {
        if (intentId) {
          await crash.transition(intentId, "submitted", { txHash: waited.txHash }, { custodyRef });
        }
        return { kind: "sent", hash: waited.txHash, intentId };
      }
      if (waited.kind === "failed") {
        const error = `custodian gave up on ${id}: ${waited.reason}`;
        if (intentId) await crash.transition(intentId, "failed", { error }, { custodyRef });
        return { kind: "aborted", broadcastAttempted: false, error };
      }
      // Not a verdict. The custodian may still send it — a human approver is the usual reason — and
      // with no hash there is nothing for the engine to hold the spend by. The intent stays live so
      // the subject is not re-driven, and reconcile settles it once the custodian does.
      throw new Error(
        `custodian reported no hash for ${id} within ${poll.timeoutMs}ms (last status ${waited.lastStatus})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ambiguous, or stopped before anything was asked. Either way the row stays LIVE: reconcile
      // asks the custodian and resolves it, rather than this path guessing at a terminal state.
      // Without a durable ref the write is bound to the claim instead, so it lands on our own
      // untouched row and is refused on one that was revived under us.
      if (intentId) {
        await crash.transition(
          intentId,
          "submitted",
          { error: message },
          referenced ? { custodyRef } : { updatedAt: claimed.attemptAt }
        );
      }
      return { kind: "aborted", broadcastAttempted: false, error: message };
    } finally {
      if (intentId) crash.endSend(intentId);
    }
  }

  /** Send an ERC-20 `approve` for any amount and wait for it to mine. See `createAutoExecutor`. */
  async function sendApprove(input: {
    token: Address;
    spender: Address;
    amount: bigint;
    action: string;
    noun: string;
    label?: string;
    guard?: () => void;
  }): Promise<AllowanceResult> {
    const { token, spender, amount, action, noun, label, guard } = input;
    const sent = await dispatch(
      { address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] },
      { target: token, action, subject: spender },
      guard
    );
    if (sent.kind === "duplicate") return sent;
    if (sent.kind === "aborted") {
      throw new Error(`${noun} was not sent for ${label ?? token}: ${sent.error}`);
    }

    // Bound to this attempt's hash, as `recordOutcome` is: while the receipt is awaited, reconcile
    // can fail the row and another engine can revive it for a new approval.
    const ours = { txHash: sent.hash };
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: sent.hash,
      timeout: txReceiptTimeoutMs,
    });
    if (receipt.status !== "success") {
      if (sent.intentId) {
        await crash.transition(
          sent.intentId,
          "failed",
          { txHash: sent.hash, error: `${noun} reverted` },
          ours
        );
      }
      throw new Error(`${noun} transaction reverted for ${label ?? token}`);
    }
    if (sent.intentId) {
      await crash.transition(sent.intentId, "confirmed", { txHash: sent.hash }, ours);
    }
    return { kind: "satisfied" };
  }

  return {
    mode: "FIREBLOCKS",
    identity,

    // Unscoped, as in AUTO and MANUAL: an intent belongs to the account, not the engine that made it.
    reconcile: () => crash.reconcile(),
    // The custodian owns the nonce.
    resyncNonces: () => Promise.resolve(),
    inFlightTxHashes: () => crash.inFlightTxHashes(),
    recordOutcome: (id, outcome) =>
      crash.transition(
        id,
        outcome.kind,
        {
          txHash: outcome.txHash,
          ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
        },
        { txHash: outcome.txHash }
      ),

    async ensureAllowance({ token, spender, required, label }) {
      const allowance = await readAllowance(publicClient, token, identity.from, spender);
      if (allowance >= required) return { kind: "satisfied" };

      logger.info(`Approving ${label ?? token} for ${spender}...`);
      const result = await sendApprove({
        token,
        spender,
        amount: maxUint256,
        action: "approval",
        noun: "Approval",
        label,
        guard: () => assertCanBroadcast("approval"),
      });
      if (result.kind === "satisfied") logger.info(`Approved ${label ?? token}`);
      return result;
    },

    async revokeAllowance({ token, spender, label }) {
      const allowance = await readAllowance(publicClient, token, identity.from, spender);
      if (allowance === 0n) return { kind: "satisfied" };

      logger.warn(`Revoking ${label ?? token} allowance for ${spender}...`);
      // Called only while HALTED, where the guard would refuse it.
      const result = await sendApprove({
        token,
        spender,
        amount: 0n,
        action: "revoke",
        noun: "Revocation",
        label,
      });
      if (result.kind === "satisfied") logger.warn(`Revoked ${label ?? token} for ${spender}`);
      return result;
    },

    async commit(call, claim) {
      const sent = await dispatch(call, claim, () => assertCanBroadcast(claim.action));
      if (sent.kind === "sent")
        return { kind: "broadcast", hash: sent.hash, intentId: sent.intentId };
      return sent;
    },
  };
}

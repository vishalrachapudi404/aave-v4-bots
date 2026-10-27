import type { Address, Hex } from "viem";

// Custody execution — the port for a signer that is not ours.
//
// `createTxSender` owns the whole send: it assembles the transaction, picks the nonce, signs, and
// broadcasts, so the tx hash exists before anything reaches the chain. A custodian (Fireblocks,
// or Galaxy's adapter in front of it) inverts all of that. We hand it `to` + calldata; *it* holds
// the key, picks the nonce and broadcasts, and the hash only appears some time after the request
// was accepted. Nothing about that fits behind `TxSender.send`, whose contract is "durably record
// the signed hash, then broadcast" — so this is a separate port, not a `Submitter`.
//
// What replaces the pre-broadcast hash as the crash-safety anchor is the **`externalTxId`**: a key
// we choose and persist *before* asking the custodian, which the custodian stores on the
// transaction it creates. After a crash we can ask "did you create the transaction for this key?"
// and get an exact answer, which is what the signed hash gave the local path.

/** Statuses a custodian reports once it has given up on a transaction. All are final. */
const CUSTODY_FAILED_STATUSES: Record<string, true> = {
  FAILED: true,
  REJECTED: true,
  BLOCKED: true,
  CANCELLED: true,
};

/** Whether `status` is one a custodian only reports after giving up on the transaction. */
export const isCustodyFailure = (status: string): boolean =>
  Object.hasOwn(CUSTODY_FAILED_STATUSES, status);

/** One contract call to have the custodian sign and broadcast. */
export interface CustodyRequest {
  /**
   * Idempotency key, persisted by the caller before this request is made. It is the only way to find
   * the transaction again if the response to `submit` is lost.
   */
  externalTxId: string;
  to: Address;
  data: Hex;
  /** Human-readable line the custodian shows its approvers. */
  note?: string;
}

/** What a custodian reports about a transaction it knows. */
export interface CustodyTx {
  id: string;
  /** The custodian's own status string, upper-cased. */
  status: string;
  subStatus?: string;
  /** Present once the custodian has broadcast. Lower-cased, `0x`-prefixed. */
  txHash?: Hex;
}

/**
 * The custodian refused the request outright — a policy rejection or an invalid payload, answered
 * with a 4xx. Nothing was created, so nothing can land. Any *other* failure of `submit` (a timeout,
 * a 5xx, a dropped connection) is ambiguous: the request may have been accepted, and only
 * `getByExternalId` can say.
 */
export class CustodyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodyRejectedError";
  }
}

export interface CustodyClient {
  /** The account transactions are sent from — the custodian's vault address on this chain. */
  readonly address: Address;
  /** Create the transaction. Returns the custodian's id for it. */
  submit(request: CustodyRequest): Promise<{ id: string }>;
  /** Look a transaction up by the custodian's id. `null` when it does not know that id (yet). */
  get(id: string): Promise<CustodyTx | null>;
  /** Look a transaction up by the `externalTxId` it was submitted under. `null` when none exists. */
  getByExternalId(externalTxId: string): Promise<CustodyTx | null>;
}

/** What a custodian's answer means for the transaction we were waiting on. */
export type CustodyState =
  /** The custodian has no record of it. */
  | { kind: "unknown" }
  /** Accepted, no hash yet — still being approved, signed or queued. */
  | { kind: "pending" }
  /** Given up on before anything reached the chain. Nothing can land. */
  | { kind: "failed"; reason: string }
  /**
   * On the wire. The receipt, not the custodian, says whether it succeeded. `abandoned` is set when
   * the custodian reports the transaction failed *after* broadcasting it — cancelled, or replaced by
   * a cancel — which a transaction that was mined never is: with no receipt, nothing will mine it.
   */
  | { kind: "broadcast"; txHash: Hex; abandoned: boolean };

/**
 * Read a custodian's answer as a `CustodyState`.
 *
 * A hash wins over a failure status. A custodian can report `FAILED` for a transaction it did
 * broadcast (an on-chain revert), and the receipt — which the engine reads for every broadcast — is
 * the authority on those: classifying one as "never sent" would release its spend while a mined
 * transaction had already moved the tokens.
 */
export function readCustodyTx(tx: CustodyTx | null): CustodyState {
  if (tx === null) return { kind: "unknown" };
  if (tx.txHash) {
    return { kind: "broadcast", txHash: tx.txHash, abandoned: isCustodyFailure(tx.status) };
  }
  if (isCustodyFailure(tx.status)) {
    return {
      kind: "failed",
      reason: tx.subStatus ? `${tx.status} (${tx.subStatus})` : tx.status,
    };
  }
  return { kind: "pending" };
}

/** What waiting on a submitted transaction ended in. */
export type CustodyWait =
  | { kind: "broadcast"; txHash: Hex }
  | { kind: "failed"; reason: string }
  /** No hash and no verdict inside the budget: the custodian may still be working on it. */
  | { kind: "timeout"; lastStatus: string };

/**
 * Poll `id` until the custodian reports a hash or gives up on it.
 *
 * A `null` answer is tolerated, not read as failure: a transaction created a moment ago may not be
 * visible to the read path yet. It still counts against the budget, so a transaction that never
 * appears ends as `timeout` — ambiguous, and left for the caller's reconcile to settle.
 */
export async function waitForCustodyHash(
  client: Pick<CustodyClient, "get">,
  id: string,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void> }
): Promise<CustodyWait> {
  // `Promise.withResolvers` is ES2024; this workspace compiles against an older `lib`.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  let lastStatus = "NOT_FOUND";
  for (;;) {
    const tx = await client.get(id);
    const state = readCustodyTx(tx);
    if (state.kind === "failed") return state;
    if (state.kind === "broadcast") return { kind: "broadcast", txHash: state.txHash };
    if (tx) lastStatus = tx.status;
    if (Date.now() >= deadline) return { kind: "timeout", lastStatus };
    await sleep(opts.intervalMs);
  }
}

import { createHash, createSign, randomUUID } from "node:crypto";
import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from "viem";
import {
  type CustodyClient,
  CustodyRejectedError,
  type CustodyRequest,
  type CustodyTx,
} from "./index";

// Fireblocks' REST API, spoken directly. Two ways in to the same API:
//
//   `api`    — a Fireblocks workspace. Every request carries a short-lived RS256 JWT signed with the
//              API user's RSA key (`X-API-Key` + `Authorization: Bearer`).
//   `galaxy` — Galaxy's internal adapter, a pass-through that signs the JWT itself, so this process
//              never holds the Fireblocks key. One `apikey` header; the adapter mounts Fireblocks at
//              `/v2/fireblocks`.
//
// Both carry identical Fireblocks payloads, so only the auth and the base path differ. That is why
// this speaks REST instead of wrapping the official SDK: the SDK would cover the `api` path only, add
// a dependency, and put the auto-generated model names between this code and the wire.
//
// Only what the executor needs: create a CONTRACT_CALL, read a transaction (by id, or by the
// `externalTxId` it was created under), and learn the vault's address.

export interface FireblocksClientConfig {
  auth: { kind: "api"; apiKey: string; privateKey: string } | { kind: "galaxy"; apiKey: string };
  /** Fireblocks API origin, or Galaxy's adapter host. */
  baseUrl: string;
  vaultAccountId: string;
  /**
   * Fireblocks' id for the chain's native asset (`ETH`, `ETH_TEST5`, `BASE_ETH`, …). It decides which
   * network the transaction is broadcast on, so a wrong one sends to the wrong chain.
   */
  assetId: string;
  feeLevel: "LOW" | "MEDIUM" | "HIGH";
  /**
   * The vault address the operator expects. Checked against what Fireblocks reports, so a vault id
   * pointed at the wrong vault stops at boot instead of spending someone else's balance.
   */
  expectedAddress?: Address;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const GALAXY_MOUNT = "/v2/fireblocks";

/** The adapter mounts Fireblocks at `/v2/fireblocks`; accept the base with or without it. */
function galaxyBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith(GALAXY_MOUNT) ? base : `${base}${GALAXY_MOUNT}`;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/**
 * The JWT Fireblocks expects on every request. `uri` and `bodyHash` bind the token to one request, so
 * a captured token cannot be replayed against another path or body; it lives 30s.
 */
function signJwt(opts: {
  apiKey: string;
  privateKey: string;
  uri: string;
  body: string;
  now?: () => number;
}): string {
  const iat = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      uri: opts.uri,
      nonce: randomUUID(),
      iat,
      exp: iat + 30,
      sub: opts.apiKey,
      bodyHash: createHash("sha256").update(opts.body).digest("hex"),
    })
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(opts.privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/**
 * PEM keys travel through env vars and secret stores, which flatten newlines into a literal `\n`.
 * Restore them rather than fail on a key that is fine.
 */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/** The adapter wraps some bodies as `{ data: … }`; Fireblocks proper never does. */
function unwrap(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const inner = record.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

function toTx(body: unknown): CustodyTx {
  const t = unwrap(body);
  const id = typeof t.id === "string" ? t.id : "";
  const rawHash = typeof t.txHash === "string" && t.txHash !== "" ? t.txHash : undefined;
  return {
    id,
    status: typeof t.status === "string" ? t.status.toUpperCase() : "",
    ...(typeof t.subStatus === "string" && t.subStatus !== "" ? { subStatus: t.subStatus } : {}),
    // Fireblocks reports EVM hashes with or without the prefix, in either case. Everything
    // downstream compares hashes as strings, so there is one spelling.
    ...(rawHash
      ? { txHash: (rawHash.startsWith("0x") ? rawHash : `0x${rawHash}`).toLowerCase() as Hex }
      : {}),
  };
}

/**
 * The first address in a vault-address listing. Fireblocks answers `{ addresses: [...] }`; the adapter
 * may answer a bare array or wrap it as `{ data: [...] }`.
 */
function firstAddress(body: unknown): string | undefined {
  let rows: unknown;
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === "object") {
    const listing = "addresses" in body ? body.addresses : "data" in body ? body.data : undefined;
    rows = listing;
  }
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (row && typeof row === "object" && "address" in row && typeof row.address === "string") {
      return row.address;
    }
  }
  return undefined;
}

export async function createFireblocksClient(
  config: FireblocksClientConfig
): Promise<CustodyClient> {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base =
    config.auth.kind === "galaxy"
      ? galaxyBase(config.baseUrl)
      : config.baseUrl.trim().replace(/\/+$/, "");
  // `uri` in the JWT is the path as Fireblocks sees it. Behind the adapter there is no JWT to sign.
  const basePath = new URL(base).pathname.replace(/\/+$/, "");

  async function request(
    method: "GET" | "POST",
    path: string,
    payload?: unknown
  ): Promise<{ status: number; body: unknown }> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.auth.kind === "galaxy") {
      headers.apikey = config.auth.apiKey;
    } else {
      headers["X-API-Key"] = config.auth.apiKey;
      headers.Authorization = `Bearer ${signJwt({
        apiKey: config.auth.apiKey,
        privateKey: config.auth.privateKey,
        uri: `${basePath}${path}`,
        body,
      })}`;
    }
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // A non-JSON error page; the raw text is what an operator needs.
    }
    return { status: response.status, body: parsed };
  }

  const describe = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

  async function readTx(path: string): Promise<CustodyTx | null> {
    const res = await request("GET", path);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Fireblocks GET ${path} → ${res.status}: ${describe(res.body)}`);
    }
    return toTx(res.body);
  }

  const addressesPath = `/v1/vault/accounts/${encodeURIComponent(config.vaultAccountId)}/${encodeURIComponent(config.assetId)}/${
    config.auth.kind === "galaxy" ? "addresses" : "addresses_paginated"
  }`;
  const resolved = await request("GET", addressesPath);
  if (resolved.status < 200 || resolved.status >= 300) {
    throw new Error(
      `Fireblocks: could not read the ${config.assetId} address of vault ${config.vaultAccountId} (${resolved.status}): ${describe(resolved.body)}`
    );
  }
  const first = firstAddress(resolved.body);
  if (first === undefined || !isAddress(first, { strict: false })) {
    throw new Error(
      `Fireblocks: vault ${config.vaultAccountId} has no ${config.assetId} address — check FIREBLOCKS_VAULT_ACCOUNT_ID and FIREBLOCKS_ASSET_ID`
    );
  }
  const address = getAddress(first);
  if (config.expectedAddress && !isAddressEqual(config.expectedAddress, address)) {
    throw new Error(
      `Fireblocks vault ${config.vaultAccountId} holds ${address} for ${config.assetId}, but ${config.expectedAddress} was expected — refusing to run against a different account`
    );
  }

  return {
    address,

    async submit(req: CustodyRequest) {
      const res = await request("POST", "/v1/transactions", {
        assetId: config.assetId,
        operation: "CONTRACT_CALL",
        source: { type: "VAULT_ACCOUNT", id: config.vaultAccountId },
        destination: { type: "ONE_TIME_ADDRESS", oneTimeAddress: { address: req.to } },
        // A call moves no native value; every token amount is inside the calldata.
        amount: "0",
        extraParameters: { contractCallData: req.data },
        feeLevel: config.feeLevel,
        externalTxId: req.externalTxId,
        ...(req.note ? { note: req.note } : {}),
      });
      if (res.status >= 200 && res.status < 300) {
        const { id } = toTx(res.body);
        // A 2xx with no id is not a refusal: the transaction may exist. Ambiguous, so not a
        // `CustodyRejectedError`.
        if (!id)
          throw new Error(`Fireblocks POST /v1/transactions returned no id: ${describe(res.body)}`);
        return { id };
      }
      const detail = `Fireblocks POST /v1/transactions → ${res.status}: ${describe(res.body)}`;
      // A 4xx (other than a timeout or rate limit) is the custodian refusing the request: nothing was
      // created. Anything else may have been accepted, and only `getByExternalId` can say.
      const refused =
        res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw refused ? new CustodyRejectedError(detail) : new Error(detail);
    },

    get: (id) => readTx(`/v1/transactions/${encodeURIComponent(id)}`),
    getByExternalId: (externalTxId) =>
      readTx(`/v1/transactions/external_tx_id/${encodeURIComponent(externalTxId)}`),
  };
}

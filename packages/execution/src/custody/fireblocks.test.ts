import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type FireblocksClientConfig, createFireblocksClient, normalizePem } from "./fireblocks";
import { CustodyRejectedError, type CustodyTx, readCustodyTx, waitForCustodyHash } from "./index";

const VAULT = getAddress("0x00000000000000000000000000000000000000aa");
const HASH = `0x${"ab".repeat(32)}`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers from `routes` (first match wins) and records every request. */
function scriptedFetch(
  routes: Array<{ match: (r: Recorded) => boolean; status?: number; json?: unknown }>
) {
  const seen: Recorded[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: (init?.body as string | undefined) ?? "",
    };
    seen.push(rec);
    const route = routes.find((r) => r.match(rec));
    if (!route) return new Response("no route", { status: 599 });
    return new Response(route.json === undefined ? "" : JSON.stringify(route.json), {
      status: route.status ?? 200,
    });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

const addressRoute = (path: string, address: string = VAULT) => ({
  match: (r: Recorded) => r.url.includes(path),
  json: { addresses: [{ address }] },
});

const apiConfig = (fetchImpl: typeof fetch): FireblocksClientConfig => ({
  auth: { kind: "api", apiKey: "api-key-1", privateKey: PRIVATE_PEM },
  baseUrl: "https://api.fireblocks.test/",
  vaultAccountId: "7",
  assetId: "ETH_TEST5",
  feeLevel: "HIGH",
  fetch: fetchImpl,
});

describe("createFireblocksClient (api)", () => {
  it("reads the vault's address and authenticates with a JWT bound to the request", async () => {
    const f = scriptedFetch([addressRoute("/v1/vault/accounts/7/ETH_TEST5/addresses_paginated")]);

    const client = await createFireblocksClient(apiConfig(f.impl));

    expect(client.address).toBe(VAULT);
    const [req] = f.seen;
    expect(req.headers["X-API-Key"]).toBe("api-key-1");

    const [header, payload, signature] = (req.headers.Authorization ?? "")
      .replace("Bearer ", "")
      .split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      uri: "/v1/vault/accounts/7/ETH_TEST5/addresses_paginated",
      sub: "api-key-1",
      // sha256 of the empty body of a GET.
      bodyHash: createHash("sha256").update("").digest("hex"),
    });
    expect(claims.exp - claims.iat).toBe(30);
    // Verifiable with the public half — i.e. actually signed with the API user's key.
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("refuses to run when the vault's address is not the one the operator expects", async () => {
    const f = scriptedFetch([addressRoute("/addresses_paginated")]);

    await expect(
      createFireblocksClient({
        ...apiConfig(f.impl),
        expectedAddress: getAddress("0x00000000000000000000000000000000000000bb"),
      })
    ).rejects.toThrow(/refusing to run against a different account/);
  });

  it("fails loud when the vault has no address for the asset", async () => {
    const f = scriptedFetch([{ match: () => true, json: { addresses: [] } }]);

    await expect(createFireblocksClient(apiConfig(f.impl))).rejects.toThrow(/FIREBLOCKS_ASSET_ID/);
  });

  it("submits a zero-value CONTRACT_CALL under the caller's externalTxId, signed over its body", async () => {
    const f = scriptedFetch([
      addressRoute("/addresses_paginated"),
      { match: (r) => r.method === "POST", json: { id: "fb-9", status: "SUBMITTED" } },
    ]);
    const client = await createFireblocksClient(apiConfig(f.impl));

    const { id } = await client.submit({
      externalTxId: "ref-1",
      to: "0x2222222222222222222222222222222222222222",
      data: "0xdeadbeef",
      note: "liquidation 0xabc",
    });

    expect(id).toBe("fb-9");
    const post = f.seen.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      assetId: "ETH_TEST5",
      operation: "CONTRACT_CALL",
      source: { type: "VAULT_ACCOUNT", id: "7" },
      destination: {
        type: "ONE_TIME_ADDRESS",
        oneTimeAddress: { address: "0x2222222222222222222222222222222222222222" },
      },
      amount: "0",
      extraParameters: { contractCallData: "0xdeadbeef" },
      feeLevel: "HIGH",
      externalTxId: "ref-1",
      note: "liquidation 0xabc",
    });
    const payload = (post?.headers.Authorization ?? "").split(".")[1];
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      uri: "/v1/transactions",
      bodyHash: createHash("sha256")
        .update(post?.body ?? "")
        .digest("hex"),
    });
  });

  // A refusal means nothing exists; anything else might have been accepted. Conflating the two is
  // either a double-send (retrying a 5xx) or a stuck subject (never freeing a 4xx).
  it.each([
    [400, true],
    [403, true],
    [408, false],
    [429, false],
    [500, false],
    [503, false],
  ])("treats a %i on submit as refused=%s", async (status, refused) => {
    const f = scriptedFetch([
      addressRoute("/addresses_paginated"),
      { match: (r) => r.method === "POST", status, json: { message: "nope" } },
    ]);
    const client = await createFireblocksClient(apiConfig(f.impl));

    const err = await client
      .submit({ externalTxId: "r", to: VAULT, data: "0x" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err instanceof CustodyRejectedError).toBe(refused);
  });

  it("does not call a 2xx with no id a refusal — the transaction may exist", async () => {
    const f = scriptedFetch([
      addressRoute("/addresses_paginated"),
      { match: (r) => r.method === "POST", json: {} },
    ]);
    const client = await createFireblocksClient(apiConfig(f.impl));

    const err = await client.submit({ externalTxId: "r", to: VAULT, data: "0x" }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CustodyRejectedError);
  });

  it("reads a transaction by external id, normalising the hash, and maps 404 to null", async () => {
    const f = scriptedFetch([
      addressRoute("/addresses_paginated"),
      {
        match: (r) => r.url.endsWith("/v1/transactions/external_tx_id/ref-1"),
        json: { id: "fb-1", status: "broadcasting", txHash: HASH.slice(2).toUpperCase() },
      },
      { match: (r) => r.url.includes("/v1/transactions/"), status: 404 },
    ]);
    const client = await createFireblocksClient(apiConfig(f.impl));

    expect(await client.getByExternalId("ref-1")).toEqual({
      id: "fb-1",
      status: "BROADCASTING",
      txHash: HASH,
    });
    expect(await client.getByExternalId("never-made")).toBeNull();
    expect(await client.get("nope")).toBeNull();
  });

  it("surfaces a server error on a read instead of reporting the transaction unknown", async () => {
    const f = scriptedFetch([
      addressRoute("/addresses_paginated"),
      {
        match: (r) => r.url.includes("/v1/transactions/"),
        status: 502,
        json: { m: "bad gateway" },
      },
    ]);
    const client = await createFireblocksClient(apiConfig(f.impl));

    // `null` would read as "the custodian never heard of it", and reconcile would fail the intent.
    await expect(client.get("x")).rejects.toThrow(/502/);
  });
});

describe("createFireblocksClient (galaxy)", () => {
  const galaxyConfig = (fetchImpl: typeof fetch, baseUrl: string): FireblocksClientConfig => ({
    auth: { kind: "galaxy", apiKey: "adapter-key" },
    baseUrl,
    vaultAccountId: "7",
    assetId: "ETH",
    feeLevel: "MEDIUM",
    fetch: fetchImpl,
  });

  it.each([
    ["https://adapter.test"],
    ["https://adapter.test/"],
    ["https://adapter.test/v2/fireblocks"],
  ])("mounts the pass-through at /v2/fireblocks exactly once (%s)", async (baseUrl) => {
    const f = scriptedFetch([{ match: () => true, json: [{ address: VAULT }] }]);

    await createFireblocksClient(galaxyConfig(f.impl, baseUrl));

    expect(f.seen[0].url).toBe(
      "https://adapter.test/v2/fireblocks/v1/vault/accounts/7/ETH/addresses"
    );
  });

  it("authenticates with the adapter's apikey alone — no JWT, no Fireblocks key", async () => {
    const f = scriptedFetch([{ match: () => true, json: { data: [{ address: VAULT }] } }]);

    await createFireblocksClient(galaxyConfig(f.impl, "https://adapter.test"));

    expect(f.seen[0].headers.apikey).toBe("adapter-key");
    expect(f.seen[0].headers.Authorization).toBeUndefined();
    expect(f.seen[0].headers["X-API-Key"]).toBeUndefined();
  });
});

describe("normalizePem", () => {
  it("restores newlines that an env var or secret store flattened into a literal \\n", () => {
    expect(normalizePem("-----BEGIN-----\\nabc\\n-----END-----")).toBe(
      "-----BEGIN-----\nabc\n-----END-----"
    );
  });

  it("leaves a key that already has real newlines alone", () => {
    expect(normalizePem(PRIVATE_PEM)).toBe(PRIVATE_PEM);
  });
});

describe("readCustodyTx", () => {
  const tx = (over: Partial<CustodyTx>): CustodyTx => ({ id: "1", status: "SUBMITTED", ...over });

  it("reads a missing transaction as unknown, not as failed", () => {
    expect(readCustodyTx(null)).toEqual({ kind: "unknown" });
  });

  it("reads a hash over a failure status: the receipt decides what a broadcast became", () => {
    expect(readCustodyTx(tx({ status: "FAILED", txHash: "0xabc" }))).toEqual({
      kind: "broadcast",
      txHash: "0xabc",
      abandoned: true,
    });
    expect(readCustodyTx(tx({ status: "COMPLETED", txHash: "0xabc" }))).toMatchObject({
      abandoned: false,
    });
  });

  it("reads a failure with no hash as nothing-can-land", () => {
    expect(readCustodyTx(tx({ status: "REJECTED", subStatus: "BY_POLICY" }))).toEqual({
      kind: "failed",
      reason: "REJECTED (BY_POLICY)",
    });
  });

  it("reads anything else as still pending", () => {
    expect(readCustodyTx(tx({ status: "PENDING_AUTHORIZATION" }))).toEqual({ kind: "pending" });
  });
});

describe("waitForCustodyHash", () => {
  const opts = { intervalMs: 1, timeoutMs: 50, sleep: async () => {} };

  it("tolerates a transaction the read path cannot see yet", async () => {
    const answers: Array<CustodyTx | null> = [
      null,
      { id: "1", status: "SUBMITTED" },
      { id: "1", status: "BROADCASTING", txHash: "0xabc" },
    ];
    const get = vi.fn(async () => answers.shift() ?? null);

    expect(await waitForCustodyHash({ get }, "1", opts)).toEqual({
      kind: "broadcast",
      txHash: "0xabc",
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("ends on a terminal failure without waiting out the budget", async () => {
    const get = vi.fn(async () => ({ id: "1", status: "BLOCKED" }));

    expect(await waitForCustodyHash({ get }, "1", opts)).toEqual({
      kind: "failed",
      reason: "BLOCKED",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("times out with the last status it saw, which is ambiguous rather than a failure", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const get = vi.fn(async () => ({ id: "1", status: "PENDING_AUTHORIZATION" }));

    const result = await waitForCustodyHash({ get }, "1", {
      ...opts,
      sleep: async () => {
        now += 30;
      },
    });

    expect(result).toEqual({ kind: "timeout", lastStatus: "PENDING_AUTHORIZATION" });
    vi.restoreAllMocks();
  });
});

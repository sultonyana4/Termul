import { createPublicClient, decodeEventLog, http, keccak256, parseAbi, recoverMessageAddress } from "npm:viem@2.57.17";
import { createSiweMessage, parseSiweMessage } from "npm:viem@2.57.17/siwe";
import { TERMUL_MAINNET as network } from "../_shared/termul-mainnet.js";
import { walletApi } from "./api.js";
import { createEOAVerifier } from "./verification.js";

const arc = createPublicClient({ transport: http(network.rpcUrl, { timeout: 8_000, retryCount: 0 }) });
const invoiceEvent = parseAbi(["event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt)"]);

function dbRequest(path: string, query: URLSearchParams, init: RequestInit = {}) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing server database configuration.");
  return fetch(new URL(`/rest/v1/${path}?${query}`, url), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
  }).then(async (result) => {
    if (!result.ok) throw new Error("Database request failed.");
    const data = await result.text();
    return data ? JSON.parse(data) : null;
  });
}

type Filters = Record<string, string | number | null>;
function filtersOf(filters: Filters) {
  return new URLSearchParams(Object.entries(filters).map(([field, value]) => [field, value === null ? "is.null" : `eq.${value}`]));
}
const db = {
  read(table: string, filters: Filters, columns: string, limit: number, order?: string) {
    const query = filtersOf(filters);
    query.set("select", columns);
    query.set("limit", String(limit));
    if (order) query.set("order", order);
    return dbRequest(table, query);
  },
  insert(table: string, row: object, conflict?: string, resolution?: string) {
    return dbRequest(table, new URLSearchParams(conflict ? { on_conflict: conflict } : {}), {
      method: "POST", body: JSON.stringify(row),
      headers: { Prefer: resolution ? `resolution=${resolution},return=minimal` : "return=minimal" },
    });
  },
  update(table: string, filters: Filters, row: object) {
    return dbRequest(table, filtersOf(filters), { method: "PATCH", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
  },
  rpc(fn: string, args: object) {
    return dbRequest(`rpc/${fn}`, new URLSearchParams(), { method: "POST", body: JSON.stringify(args) });
  },
};

Deno.serve(walletApi({
  db,
  createSiweMessage,
  parseSiweMessage,
  verifyEOA: createEOAVerifier({ client: arc, recoverMessageAddress }),
  async verifyCreation({ merchant, invoiceId, txHash, amount, expiresAt }: {
    merchant: string; invoiceId: string; txHash: `0x${string}`; amount: bigint; expiresAt: bigint;
  }) {
    if (await arc.getChainId() !== network.id) return false;
    const code = await arc.getCode({ address: network.contractAddress });
    if (!code || keccak256(code) !== network.runtimeHash) return false;
    const receipt = await arc.getTransactionReceipt({ hash: txHash });
    return receipt.status === "success" && receipt.transactionHash.toLowerCase() === txHash
      && receipt.blockNumber >= network.deploymentBlock
      && receipt.logs.some((log) => {
        if (log.removed || log.transactionHash?.toLowerCase() !== txHash
          || log.address.toLowerCase() !== network.contractAddress) return false;
        try {
          const { args } = decodeEventLog({ abi: invoiceEvent, data: log.data, topics: log.topics });
          return args.merchant.toLowerCase() === merchant && args.invoiceId.toLowerCase() === invoiceId
            && args.amount === amount && args.expiresAt === expiresAt;
        } catch {
          return false;
        }
      });
  },
}));

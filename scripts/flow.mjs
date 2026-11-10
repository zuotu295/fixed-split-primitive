/* On-chain evidence flow for FixedSplit on Stable Studionet.
 *
 * Usage: node scripts/flow.mjs   (uses deployment.json for the address)
 *
 * Ephemeral accounts only (keys never written to disk). Every account
 * is funded 10000 GEN from the faucet simulation (sim_fundAccount;
 * real testnet GEN, zero cash cost).
 *
 * Flow (7 writes + 1 deploy = 8 transactions):
 *   S0: create [A,B,C] 50/30/20 -> fund 100 GEN
 *       -> BAD distribute [49,31,20] GEN: same sum, wrong vector,
 *          must fail DISTRIBUTION_MISMATCH, state stays FUNDED
 *       -> GOOD distribute [50,30,20] GEN: exact, remainder 0
 *   S1: create [A,B,C] 1/1/1 -> fund 100 GEN
 *       -> GOOD distribute [floor+1, floor, floor] wei: the 1 wei
 *          remainder goes to the first beneficiary only
 *   The repeat-distribute case (ALREADY_DISTRIBUTED) is covered by the
 *   local mock tests, not by an on-chain transaction.
 *   Final: every EOA balance checked to the wei; GEN conserved
 *   (200 GEN in = 200 GEN out, contract balance 0).
 *
 * RPC discipline: reads retry with exponential back-off; receipts are
 * polled slowly (12 s); a write is submitted exactly ONCE per attempt
 * and never re-submitted on a polling failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const GEN = 10n ** 18n;
const FUND_GEN = 10000;
const genStr = (wei) => {
  const w = BigInt(wei);
  const whole = w / GEN;
  const frac = w % GEN;
  if (frac === 0n) return `${whole} GEN`;
  return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")} GEN`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- accounts (ephemeral; keys never leave this process) --------------------
const names = ["creator", "a", "b", "c"];
const accounts = {};
for (const name of names) {
  accounts[name] = createAccount(generatePrivateKey());
  console.log(`${name}: ${accounts[name].address}`);
}
const addr = (name) => accounts[name].address.toLowerCase();
console.log("Contract:", address);

const clientFor = (account) => createClient({ chain: studionet, account });
const reader = clientFor(accounts.creator);

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  deployTxHash: deployment.deployTxHash,
  contractFile: "contracts/fixed_split.py",
  contractSha256: deployment.contractSha256,
  deployedCodeSha256: deployment.deployedCodeSha256,
  deployedCodeMatchesSource: deployment.deployedCodeMatchesSource,
  accounts: Object.fromEntries(names.map((n) => [n, accounts[n].address])),
  funding: {},
  splits: [],
  transactions: [],
  finalReadbacks: null,
  invariant: null,
  generatedAt: new Date().toISOString(),
};
const save = () => writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");

// --- rate-limit-aware reads --------------------------------------------------
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
function retryAfterMs(err) {
  let node = err;
  for (let i = 0; i < 5 && node; i++) {
    const secs = node?.data?.retry_after_seconds ?? node?.cause?.data?.retry_after_seconds;
    if (typeof secs === "number" && secs > 0) return Math.min(secs * 1000, 1500000);
    if (typeof node?.message === "string" && /rate limit/i.test(node.message)) {
      const m = node.message.match(/retry_after_seconds\D*(\d+)/);
      if (m) return Math.min(Number(m[1]) * 1000, 1500000);
    }
    node = node?.cause;
  }
  return null;
}
async function withRetry(fn, label, maxAttempts = 15) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await fn();
      if (typeof out === "string" && out.trimStart().startsWith("<")) {
        throw new Error("HTML error page instead of JSON");
      }
      return out;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === maxAttempts || !RETRYABLE.test(msg)) throw e;
      const wait = retryAfterMs(e) ?? delay;
      console.log(`  [retry ${label} attempt ${attempt}/${maxAttempts} after ${Math.round(wait / 1000)}s: ${msg.slice(0, 120)}]`);
      await sleep(wait);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function rpc(method, params) {
  return withRetry(() => reader.request({ method, params }), `rpc ${method}`);
}

async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) return JSON.parse(raw);
  return raw;
}

async function getBalanceWei(addrStr) {
  const bal = await withRetry(
    () => reader.getBalance({ address: addrStr }),
    `balance ${addrStr.slice(0, 10)}`,
  );
  return BigInt(bal.toString());
}

async function contractBalanceWei() {
  const hex = await rpc("eth_getBalance", [address, "latest"]);
  return BigInt(hex);
}

// --- receipt polling (slow; never re-submits) --------------------------------
const STATUS = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const statusOf = (r) => r.status_name ?? r.statusName ?? STATUS[r.status] ?? String(r.status ?? "");
const resultOf = (r) => r.result_name ?? r.resultName ?? "";
function leaderOf(receipt) {
  const list = receipt.consensus_data?.leader_receipt || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.find((x) => x.mode === "leader") || arr[arr.length - 1] || {};
}

function decodeResultField(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf-8").replace(/^[^\x20-\x7E]+/, "");
  } catch {
    return "";
  }
}
function errorTextOf(leader) {
  const fromResult = decodeResultField(leader.result);
  const fromStderr = (leader.genvm_result?.stderr || leader.stderr || "").toString();
  return [fromResult, fromStderr].filter(Boolean).join("\n");
}

async function pollReceipt(hash, label, maxPolls = 40, intervalMs = 12000) {
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await rpc("eth_getTransactionByHash", [hash]);
    if (receipt && (statusOf(receipt) === "FINALIZED" || statusOf(receipt) === "CANCELED")) {
      return receipt;
    }
    if (i % 5 === 0) console.log(`  ${label}: waiting (${statusOf(receipt || {}) || "unknown"}), poll ${i + 1}/${maxPolls}`);
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not finalize after ${maxPolls} polls (tx ${hash})`);
}

// --- writes: submitted exactly once per attempt ------------------------------
async function write(account, functionName, args, label, value = 0n, expectError = null) {
  const client = clientFor(account);
  const hash = await client.writeContract({ address, functionName, args, value, leaderOnly: false });
  console.log(`${label} tx: ${hash}${value > 0n ? ` (value ${genStr(value)})` : ""}`);
  const receipt = await pollReceipt(hash, label);
  const status = statusOf(receipt);
  const consensus = resultOf(receipt);
  const leader = leaderOf(receipt);
  const execution = leader.execution_result || leader.executionResult || "";
  const stderr = errorTextOf(leader);
  const record = {
    label,
    method: functionName,
    args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === "bigint" ? v.toString() : v))),
    sender: account.address,
    value_wei: value.toString(),
    txHash: hash,
    receiptStatus: status,
    consensus,
    execution,
    expected_error: expectError,
    stderr_excerpt: stderr.slice(0, 500),
  };
  evidence.transactions.push(record);
  save();
  if (status !== "FINALIZED") throw new Error(`${label} ended ${status}, not FINALIZED (tx ${hash})`);
  if (consensus !== "MAJORITY_AGREE") throw new Error(`${label} consensus ${consensus}, not MAJORITY_AGREE (tx ${hash})`);
  if (expectError) {
    if (execution !== "ERROR") throw new Error(`${label} expected ERROR but leader executed ${execution} (tx ${hash})`);
    if (!stderr.includes(expectError)) {
      throw new Error(`${label} expected error ${expectError} but stderr was: ${stderr.slice(0, 300)} (tx ${hash})`);
    }
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / ERROR (${expectError}) as expected`);
  } else {
    if (execution !== "SUCCESS") throw new Error(`${label} expected SUCCESS but leader executed ${execution}: ${stderr.slice(0, 300)} (tx ${hash})`);
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / SUCCESS`);
  }
  return { hash, receipt, record };
}

function assertEq(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function pollUntil(label, fn, ok, timeoutMs = 90000, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${label}: state did not appear within ${timeoutMs / 1000}s; last value: ${JSON.stringify(last).slice(0, 400)}`);
    }
    await sleep(intervalMs);
  }
}

// ===========================================================================
// Main flow
// ===========================================================================
console.log("Flow start:", new Date().toISOString());

// --- 0. fund all accounts ----------------------------------------------------
for (const name of names) {
  const account = accounts[name];
  const client = clientFor(account);
  const fundTx = await withRetry(
    () => client.request({ method: "sim_fundAccount", params: [account.address, FUND_GEN * 10 ** 18] }),
    `fund ${name}`,
  );
  const bal = await getBalanceWei(account.address);
  assertEq(bal, BigInt(FUND_GEN) * GEN, `fund ${name} balance`);
  evidence.funding[name] = { address: account.address, funded_gen: FUND_GEN, fundTx: String(fundTx), balance_after_wei: bal.toString() };
  console.log(`fund ${name}: balance ${genStr(bal)}`);
}
save();

// --- preflight: fresh contract ------------------------------------------------
{
  const pre = await readJson("get_totals", []);
  if (pre.total_received_wei !== "0") {
    throw new Error(`contract is not fresh: total_received_wei is ${pre.total_received_wei}, expected 0. Redeploy a fresh contract before running the flow.`);
  }
  console.log("  preflight: fresh contract (0 received)");
}

// --- S0: 100 GEN at 50/30/20 --------------------------------------------------
const beneficiaries = [addr("a"), addr("b"), addr("c")];
console.log("\n--- S0: 100 GEN, shares 50/30/20 ---");
const createS0 = await write(
  accounts.creator, "create_split",
  [JSON.stringify(beneficiaries), JSON.stringify([50, 30, 20])],
  "create-S0-50-30-20",
);
const s0Id = `${addr("creator")}:0`;
{
  const back = await pollUntil(
    "S0 readback after create",
    () => readJson("get_split", [s0Id]),
    (b) => b.id === s0Id && b.state === "CREATED" && b.total_shares === 100,
  );
  console.log(`  S0 id: ${s0Id}, state ${back.state}`);
}
await write(accounts.creator, "fund", [s0Id], "fund-S0-100-GEN", 100n * GEN);
{
  await pollUntil(
    "S0 readback after fund",
    () => readJson("get_split", [s0Id]),
    (b) => b.state === "FUNDED" && b.funded_wei === (100n * GEN).toString(),
  );
}
// BAD: same sum (100 GEN), 1 GEN moved from first to second beneficiary.
const badVec = [(49n * GEN).toString(), (31n * GEN).toString(), (20n * GEN).toString()];
await write(
  accounts.creator, "distribute", [s0Id, JSON.stringify(badVec)],
  "adversarial-tampered-vector-S0", 0n, "DISTRIBUTION_MISMATCH",
);
{
  const back = await readJson("get_split", [s0Id]);
  assertEq(back.state, "FUNDED", "tampered distribute changed S0 state");
  assertEq(JSON.stringify(back.distribution_wei), "[]", "tampered distribute recorded a distribution");
  const balA = await getBalanceWei(accounts.a.address);
  assertEq(balA, BigInt(FUND_GEN) * GEN, "tampered distribute paid A");
  console.log("  S0 still FUNDED after tampered distribute; nobody paid");
}
// GOOD: exact vector [50, 30, 20] GEN.
const goodS0 = [(50n * GEN).toString(), (30n * GEN).toString(), (20n * GEN).toString()];
await write(accounts.creator, "distribute", [s0Id, JSON.stringify(goodS0)], "distribute-S0-good");
{
  await pollUntil(
    "S0 readback after distribute",
    () => readJson("get_split", [s0Id]),
    (b) => b.state === "DISTRIBUTED" && JSON.stringify(b.distribution_wei) === JSON.stringify(goodS0),
  );
  const [balA, balB, balC] = await Promise.all(
    ["a", "b", "c"].map((n) =>
      pollUntil(`EOA balance ${n} after S0`, () => getBalanceWei(accounts[n].address),
        (b) => b === BigInt(FUND_GEN) * GEN + { a: 50n, b: 30n, c: 20n }[n] * GEN)),
  );
  console.log(`  S0 paid: A ${genStr(balA - BigInt(FUND_GEN) * GEN)}, B ${genStr(balB - BigInt(FUND_GEN) * GEN)}, C ${genStr(balC - BigInt(FUND_GEN) * GEN)}`);
}
evidence.splits.push({
  id: s0Id, shares: [50, 30, 20], funded_wei: (100n * GEN).toString(),
  expected_distribution_wei: goodS0, remainder_wei: "0", remainder_to: beneficiaries[0],
  tampered_vector_wei: badVec, tampered_error: "DISTRIBUTION_MISMATCH",
  createTxHash: createS0.hash,
});
save();

// --- S1: 100 GEN at 1/1/1 (1 wei remainder to first) ---------------------------
console.log("\n--- S1: 100 GEN, shares 1/1/1 (remainder case) ---");
const floor = (100n * GEN) / 3n; // 33333333333333333333 wei
const goodS1 = [(floor + 1n).toString(), floor.toString(), floor.toString()];
console.log(`  floor per share: ${floor} wei; remainder 1 wei -> first beneficiary gets ${floor + 1n}`);
const createS1 = await write(
  accounts.creator, "create_split",
  [JSON.stringify(beneficiaries), JSON.stringify([1, 1, 1])],
  "create-S1-1-1-1",
);
const s1Id = `${addr("creator")}:1`;
await write(accounts.creator, "fund", [s1Id], "fund-S1-100-GEN", 100n * GEN);
await write(accounts.creator, "distribute", [s1Id, JSON.stringify(goodS1)], "distribute-S1-good-remainder");
{
  await pollUntil(
    "S1 readback after distribute",
    () => readJson("get_split", [s1Id]),
    (b) => b.state === "DISTRIBUTED" && b.remainder_wei === "1" && JSON.stringify(b.distribution_wei) === JSON.stringify(goodS1),
  );
  const [balA, balB, balC] = await Promise.all(
    ["a", "b", "c"].map((n) =>
      pollUntil(`EOA balance ${n} after S1`, () => getBalanceWei(accounts[n].address),
        (b) => b === BigInt(FUND_GEN) * GEN + { a: 50n, b: 30n, c: 20n }[n] * GEN + (n === "a" ? floor + 1n : floor))),
  );
  console.log(`  S1 paid: A +${floor + 1n} wei, B +${floor} wei, C +${floor} wei (A got the 1 wei remainder)`);
}
evidence.splits.push({
  id: s1Id, shares: [1, 1, 1], funded_wei: (100n * GEN).toString(),
  expected_distribution_wei: goodS1, remainder_wei: "1", remainder_to: beneficiaries[0],
  createTxHash: createS1.hash,
});
save();

// --- final read-backs -----------------------------------------------------------
console.log("\n--- final read-backs ---");
const finalS0 = await readJson("get_split", [s0Id]);
const finalS1 = await readJson("get_split", [s1Id]);
const finalTotals = await readJson("get_totals", []);
const finalContractBalance = await contractBalanceWei();
const expectedEoa = {
  creator: (BigInt(FUND_GEN) * GEN - 200n * GEN).toString(),
  a: (BigInt(FUND_GEN) * GEN + 50n * GEN + floor + 1n).toString(),
  b: (BigInt(FUND_GEN) * GEN + 30n * GEN + floor).toString(),
  c: (BigInt(FUND_GEN) * GEN + 20n * GEN + floor).toString(),
};
const finalEoa = {};
for (const name of names) {
  finalEoa[name] = (
    await pollUntil(
      `final EOA balance ${name}`,
      () => getBalanceWei(accounts[name].address),
      (b) => b.toString() === expectedEoa[name],
    )
  ).toString();
}
assertEq(finalTotals.total_received_wei, (200n * GEN).toString(), "final received 200 GEN");
assertEq(finalTotals.total_distributed_wei, (200n * GEN).toString(), "final distributed 200 GEN");
assertEq(finalTotals.contract_balance_wei, "0", "final contract balance 0");
assertEq(finalContractBalance, 0n, "final contract balance (eth_getBalance) 0");
if (finalTotals.invariant_ok !== true) throw new Error("final invariant_ok false");
console.log("  final totals:", JSON.stringify(finalTotals));
console.log("  final EOA balances all match expected values to the wei");

evidence.finalReadbacks = {
  splits: [finalS0, finalS1],
  totals: finalTotals,
  contractBalanceWei: finalContractBalance.toString(),
  eoaBalancesWei: finalEoa,
  expectedEoaBalancesWei: expectedEoa,
  readBackAt: new Date().toISOString(),
};
evidence.invariant = {
  received_wei: finalTotals.total_received_wei,
  distributed_wei: finalTotals.total_distributed_wei,
  contract_balance_wei: finalTotals.contract_balance_wei,
  invariant_ok: finalTotals.invariant_ok,
  in_equals_out: finalTotals.total_received_wei === finalTotals.total_distributed_wei,
};
evidence.generatedAt = new Date().toISOString();
save();
console.log("\nFLOW COMPLETE. Wrote evidence.json with", evidence.transactions.length, "transactions.");

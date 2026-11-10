/* Independent re-check for FixedSplit: re-reads the live contract state
 * and compares it against evidence.json. No writes, no new transactions.
 *
 * Usage: node scripts/verify.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const evidence = JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf-8"));
const address = deployment.contractAddress;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
async function withRetry(fn, label, maxAttempts = 10) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts || !RETRYABLE.test(String(e?.message || e))) throw e;
      console.log(`  [retry ${label} ${attempt}/${maxAttempts}]`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}
async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? JSON.parse(raw) : raw;
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("Contract:", address);
console.log("Explorer:", deployment.explorer);

// 1. Deployed code still matches the source file.
const { createHash } = await import("node:crypto");
const code = readFileSync(path.join(root, "contracts", "fixed_split.py"), "utf-8");
check("source SHA matches deployment.json", createHash("sha256").update(code).digest("hex") === deployment.contractSha256);
const cc = await withRetry(() => reader.request({ method: "gen_getContractCode", params: [address] }), "gen_getContractCode");
let decoded = null;
try { decoded = Buffer.from(cc, "base64").toString("utf-8"); } catch { /* ignore */ }
if (decoded !== code && cc === code) decoded = cc;
check("live deployed code matches source", decoded === code);

// 2. Splits re-read live match evidence.json.
for (const s of evidence.splits) {
  const live = await readJson("get_split", [s.id]);
  check(`${s.id} state DISTRIBUTED`, live.state === "DISTRIBUTED");
  check(`${s.id} distribution matches evidence`, JSON.stringify(live.distribution_wei) === JSON.stringify(s.expected_distribution_wei));
  check(`${s.id} remainder ${s.remainder_wei}`, live.remainder_wei === s.remainder_wei);
  check(`${s.id} distribution sums to funded total`,
    BigInt(live.distribution_wei.reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), "0")) === BigInt(live.funded_wei));
}

// 3. Totals + invariant.
const totals = await readJson("get_totals", []);
check("totals received == distributed == 200 GEN",
  totals.total_received_wei === totals.total_distributed_wei &&
  totals.total_received_wei === (200n * 10n ** 18n).toString());
check("contract balance 0", totals.contract_balance_wei === "0");
check("invariant_ok", totals.invariant_ok === true);

// 4. EOA balances still match the expected values to the wei.
for (const [name, expected] of Object.entries(evidence.finalReadbacks.expectedEoaBalancesWei)) {
  const bal = await withRetry(() => reader.getBalance({ address: evidence.accounts[name] }), `balance ${name}`);
  check(`EOA ${name} balance`, BigInt(bal.toString()) === BigInt(expected), `${bal} wei`);
}

// 5. Every recorded transaction is FINALIZED.
for (const tx of evidence.transactions) {
  check(`tx ${tx.label} FINALIZED`, tx.receiptStatus === "FINALIZED", tx.txHash);
}

console.log(failures === 0 ? "\nVERIFY: ALL CHECKS PASS" : `\nVERIFY: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

/* Deploy FixedSplit to Stable Studionet (chain 61999) only.
 *
 * Usage:
 *   node scripts/deploy.mjs            # ephemeral deployer key (this run only)
 *   GENLAYER_PRIVATE_KEY=0x... node scripts/deploy.mjs
 *
 * The private key is NEVER written to disk or to deployment.json.
 * After deploy, the deployed code is read back with gen_getContractCode
 * (base64), decoded, and SHA-256 compared against the source file byte
 * for byte. A mismatch stops the script: FINALIZED alone is not proof
 * the deployed code is the repo code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codePath = path.join(root, "contracts", "fixed_split.py");
const code = readFileSync(codePath, "utf-8");
const codeSha = createHash("sha256").update(code).digest("hex");
console.log("Source SHA-256:", codeSha);

const suppliedKey = process.env.GENLAYER_PRIVATE_KEY;
const privateKey = suppliedKey || generatePrivateKey();
if (!suppliedKey) {
  console.log("No GENLAYER_PRIVATE_KEY supplied: using an ephemeral deployer key for this run only.");
}
const account = createAccount(privateKey);
console.log("Deployer:", account.address);
console.log("Network: Stable Studionet, chain 61999, https://studio.genlayer.com/api");

const client = createClient({ chain: studionet, account });
const txHash = await client.deployContract({ code, args: [], leaderOnly: false });
console.log("Deploy tx:", txHash);

const STATUS = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.FINALIZED,
  retries: 180,
  interval: 5000,
});
const statusName = receipt.statusName ?? STATUS[receipt.status] ?? String(receipt.status ?? "");
console.log("Receipt status:", statusName);
if (statusName !== "FINALIZED") throw new Error(`Deploy did not finalize: ${statusName}`);

const address =
  receipt?.data?.contract_address ??
  receipt?.txDataDecoded?.contractAddress ??
  receipt?.contractAddress ??
  null;
if (!address) {
  console.log("Full receipt (no private key):", JSON.stringify(receipt, null, 2).slice(0, 4000));
  throw new Error("Could not find contract address in deploy receipt");
}
console.log("Contract address:", address);

// Read back the deployed code and compare byte for byte with the source.
const cc = await client.request({ method: "gen_getContractCode", params: [address] });
if (typeof cc !== "string" || cc.length === 0) throw new Error("gen_getContractCode returned nothing usable");
let decoded = null;
try {
  decoded = Buffer.from(cc, "base64").toString("utf-8");
} catch { /* fall through to the direct comparison below */ }
if (decoded !== code) {
  if (cc === code) decoded = cc;
}
if (decoded !== code) {
  console.log("gen_getContractCode length:", cc.length, "decoded length:", decoded ? decoded.length : -1, "source length:", code.length);
  throw new Error("DEPLOYED CODE DOES NOT MATCH SOURCE FILE — refusing to record this deployment");
}
const deployedCodeSha = createHash("sha256").update(decoded).digest("hex");
console.log("Deployed code SHA-256:", deployedCodeSha, "| match:", deployedCodeSha === codeSha);

const deployment = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  studio: `https://studio.genlayer.com/?import-contract=${address}`,
  contractAddress: address,
  deployTxHash: txHash,
  deployer: account.address,
  contractFile: "contracts/fixed_split.py",
  contractSha256: codeSha,
  deployedCodeSha256: deployedCodeSha,
  deployedCodeMatchesSource: deployedCodeSha === codeSha,
  deployedAt: new Date().toISOString(),
  receiptStatus: statusName,
};
writeFileSync(path.join(root, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
console.log("Wrote deployment.json");

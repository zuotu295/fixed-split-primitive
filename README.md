# FixedSplit — deterministic fixed-ratio split primitive

固定比例分账原语：一笔收入按预设固定比例分给 N 个地址，任何人可触发分账，分账结果可重算。

FixedSplit is a deterministic fixed-ratio split primitive: one funded amount is split across N beneficiaries at pre-locked integer shares. Anyone can trigger the split; the result is recomputable by anyone from (total, shares) alone.

- Network: Stable Studionet, Chain ID 61999, RPC https://studio.genlayer.com/api
- Contract: `0x1294911238B306a61Eef05f5f9DedBBF3f32709e`
- Explorer: https://explorer-studio.genlayer.com/address/0x1294911238B306a61Eef05f5f9DedBBF3f32709e
- Source: `contracts/fixed_split.py`
- Source SHA-256: `4862a88229dcb84fd1dbc3608aa0dba8a94ee4ea9c83dc73cee60ef7f92bd04c`
- Deployed code matches the source byte for byte (checked with `gen_getContractCode`).

## Mechanism / 机制

One thing, one table, exact equality, one explicit counterexample on-chain.

1. `create_split(beneficiaries_json, shares_json)` locks the split table: 2–8 beneficiaries, lowercase `0x` addresses, no duplicates, each share a positive integer (1–1,000,000). Returns the split id (`<creator-address>:<index>`).
2. `fund(split_id)` is payable and deposits the amount to split, exactly once.
3. `distribute(split_id, claimed_json)` takes a caller-proposed allocation vector and requires **exact element-wise equality** with the vector the contract recomputes deterministically, plus an exact sum check (the sum must equal the funded total, not one wei more or less). Any single entry off by one wei fails the call and changes no state. On success it pays every beneficiary out immediately and the split becomes terminal.

No LLM is used: this is pure deterministic integer arithmetic. Leader and validators each recompute the same vector from the same locked inputs; there is no judgement call anywhere in the decision.

## Remainder rule / 余数规则

Each share is floored first: `amount_i = total * share_i // total_shares`. The whole leftover remainder (`total - sum of floors`) goes to `beneficiaries[0]`. The rule is fixed in the contract and is not a choice at split time. Note the indivisible unit is the wei, not the GEN: 101 GEN at 50/30/20 divides exactly in wei (50.5 / 30.3 / 20.2 GEN are whole wei amounts), so its remainder is 0.

## State machine / 状态机

```
CREATED --fund()--> FUNDED --distribute()--> DISTRIBUTED (terminal)
```

- `fund` only from `CREATED`; a second `fund` fails.
- `distribute` only from `FUNDED`; a second `distribute` fails with `ALREADY_DISTRIBUTED` (covered by the local mock tests, `tests/test_fixed_split.py`).
- A tampered allocation vector fails with `DISTRIBUTION_MISMATCH`; a vector whose sum is not the funded total fails with `SUM_MISMATCH`.

## How to call / 调用方法

All amounts are wei as decimal strings inside JSON. All on-chain values are English.

```js
// 1. Lock the table: 3 beneficiaries at 50/30/20.
create_split(
  JSON.stringify(["0x...", "0x...", "0x..."]),
  JSON.stringify([50, 30, 20]),
); // -> "<creator>:0"

// 2. Fund it with 100 GEN (payable, value = 100 * 10^18 wei).
fund("<creator>:0"); // value: 100000000000000000000

// 3. Trigger the split with the exact recomputed vector.
distribute("<creator>:0", JSON.stringify([
  "50000000000000000000", // 50 GEN
  "30000000000000000000", // 30 GEN
  "20000000000000000000", // 20 GEN
]));
```

Reads:

```js
get_protocol(); // protocol, bounds, remainder rule, states
get_split("<creator>:0"); // id, owner, beneficiaries, shares, state, funded_wei, distribution_wei, remainder_wei
get_totals(); // total_received_wei, total_distributed_wei, contract_balance_wei, invariant_ok
```

## Evidence / 证据

All transactions FINALIZED with MAJORITY_AGREE consensus. Full machine-readable evidence: [`evidence.json`](evidence.json). Deployment record: [`deployment.json`](deployment.json).

| Case | Transaction | Result |
| --- | --- | --- |
| Deploy | `0xcae7d218c583a325bff2401cbb2b3832bf355d8f3da498e1eee610a42ef53a3d` | FINALIZED, contract `0x1294911238B306a61Eef05f5f9DedBBF3f32709e` |
| S0 create 50/30/20 | `0x487a1dc8694e621fc85cf0cbf646976f977e84437adfc3640a60b5bb40e3e2cc` | FINALIZED / SUCCESS |
| S0 fund 100 GEN | `0x63c8b369da4dc4dc6effcd785de5b0c682b26c58c2dc02aa5f9a717deb112b58` | FINALIZED / SUCCESS |
| S0 BAD distribute `[49, 31, 20]` GEN | `0xed3c00e30a6c111982955013ba4af2ced65abd86eb2b4d53576c57c76eff571e` | FINALIZED / ERROR `DISTRIBUTION_MISMATCH` — same sum, wrong vector; state stayed FUNDED, nobody paid |
| S0 GOOD distribute `[50, 30, 20]` GEN | `0x954040874df519e41631eb5cd6b681260116b9b5ab520ea3351d4de35e27194d` | FINALIZED / SUCCESS — paid exactly 50 / 30 / 20 GEN, remainder 0 |
| S1 create 1/1/1 | `0x641c020dc4450bf1f7a5ca1f19336a814c8020a7211d5aa31b48178d0875a86c` | FINALIZED / SUCCESS |
| S1 fund 100 GEN | `0xe6f0977418f966155a90d6839fe63e29b720300f037106f26771f0922c48565d` | FINALIZED / SUCCESS |
| S1 GOOD distribute `[33333333333333333334, 33333333333333333333, 33333333333333333333]` wei | `0xb363b1c58657d5dd3b293fbddb968891b1714b39db8819d0415c1876f9b25f1e` | FINALIZED / SUCCESS — 1 wei remainder to the first beneficiary |

GEN accounting (checked to the wei, EOA balances read back live):

- Funded: 200 GEN (100 + 100). Distributed: 200 GEN. Contract balance: 0. `invariant_ok: true`.
- Creator: 10000 → 9800 GEN. A: 10000 → 10083.333333333333333334 GEN. B: 10000 → 10063.333333333333333333 GEN. C: 10000 → 10053.333333333333333333 GEN.
- S0: A +50, B +30, C +20 GEN. S1: A +33333333333333333334 wei, B +33333333333333333333 wei, C +33333333333333333333 wei.

## Reuse / 复用价值

Any revenue share, royalty split, or donation split can reuse this primitive: lock the table once, fund, and anyone can trigger the exact split. The same contract also serves as the deterministic core for any fixed-ratio payout.

## Tests / 测试

`tests/test_fixed_split.py` runs the real contract source locally with a stubbed host module (local mock only — not chain consensus evidence). It covers exact division, the 1 wei remainder rule, tampered vectors, off-by-one sums, fund guards, and the repeat-distribute terminal rule:

```bash
npm test   # python3 tests/test_fixed_split.py — 8 tests
```

Reproduce the on-chain flow and the independent re-check:

```bash
npm run deploy   # ephemeral deployer key; writes deployment.json
npm run flow     # evidence flow; writes evidence.json
npm run verify   # re-reads live state and compares with evidence.json
```

## Limits / 已知限制

- Beneficiaries are paid by push transfer inside `distribute`; all demo beneficiaries are EOAs.
- At most 8 beneficiaries and 8 splits per owner.
- Amounts are integer wei; shares are integers, so ratios that need finer granularity must be scaled into the share integers.

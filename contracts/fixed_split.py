# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""FixedSplit: deterministic fixed-ratio split primitive.

One thing: split one funded amount across N beneficiaries at fixed,
pre-locked integer shares. Anyone may trigger the split; the result is
recomputable by anyone from (total, shares) alone.

Remainder rule (fixed, written here and in the README): each share is
floored first, amount_i = total * share_i // total_shares, and the whole
leftover remainder (total - sum of floors) goes to beneficiaries[0].
The rule is part of the mechanism, not a choice at split time.

Equivalence check: distribute() takes a caller-proposed allocation
vector and requires EXACT element-wise equality with the vector the
contract recomputes deterministically, plus an exact sum check
(sum must equal the funded total, not one wei more or less). Any
single entry off by one wei, or any remainder placed anywhere but
beneficiaries[0], fails the call and changes no state. Leader and
validators each recompute the same vector from the same locked inputs;
there is no judgement call anywhere in the decision.

State machine: CREATED -> FUNDED -> DISTRIBUTED (terminal).
  - create_split locks the beneficiary/share table.
  - fund (payable) deposits the amount to split, exactly once.
  - distribute pays every beneficiary out immediately (push) and locks
    the split forever; a second distribute always fails.
No LLM is used: this is pure deterministic integer arithmetic.
"""

import json

from genlayer import *

PROTOCOL = "fixedsplit-1"
MAX_BENEFICIARIES = 8
MAX_SPLITS_PER_OWNER = 8
MAX_SHARE = 1000000
REMAINDER_RULE = "remainder_to_first_beneficiary"


def pack(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def need(ok, code):
    if not ok:
        raise gl.vm.UserError("EXPECTED: " + code)


def unique_pairs(pairs):
    d = {}
    for key, value in pairs:
        need(key not in d, "DUPLICATE_JSON_KEY")
        d[key] = value
    return d


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs) if isinstance(raw, str) else raw


def is_lower_address(value):
    return (
        type(value) is str
        and len(value) == 42
        and value.startswith("0x")
        and all(c in "0123456789abcdef" for c in value[2:])
    )


def compute_distribution(total, shares):
    """Pure function: the full allocation vector for (total, shares).

    Floors first, whole remainder to index 0. Sum is exactly total.
    """
    total_shares = sum(shares)
    amounts = [(total * s) // total_shares for s in shares]
    remainder = total - sum(amounts)
    amounts[0] += remainder
    return amounts, remainder


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class FixedSplit(gl.Contract):
    splits: TreeMap[str, str]
    counts: TreeMap[str, u32]
    total_received: u256
    total_distributed: u256

    def __init__(self):
        self.total_received = u256(0)
        self.total_distributed = u256(0)

    @gl.public.view
    def get_protocol(self) -> str:
        return pack({
            "protocol": PROTOCOL,
            "max_beneficiaries": MAX_BENEFICIARIES,
            "max_splits_per_owner": MAX_SPLITS_PER_OWNER,
            "max_share": MAX_SHARE,
            "remainder_rule": REMAINDER_RULE,
            "states": ["CREATED", "FUNDED", "DISTRIBUTED"],
        })

    @gl.public.view
    def get_split(self, split_id: str) -> str:
        return self.splits.get(split_id, "")

    @gl.public.view
    def get_totals(self) -> str:
        received = int(self.total_received)
        distributed = int(self.total_distributed)
        balance = int(self.balance)
        return pack({
            "total_received_wei": str(received),
            "total_distributed_wei": str(distributed),
            "contract_balance_wei": str(balance),
            "invariant_ok": received == distributed + balance,
        })

    def _load(self, split_id):
        raw = self.splits.get(split_id, "")
        need(bool(raw), "NOT_FOUND")
        return parse(raw)

    def _save(self, split):
        self.splits[split["id"]] = pack(split)

    @gl.public.write
    def create_split(self, beneficiaries_json: str, shares_json: str) -> str:
        need(len(beneficiaries_json) <= 2000 and len(shares_json) <= 500, "INPUT_BOUND")
        beneficiaries = parse(beneficiaries_json)
        shares = parse(shares_json)
        need(type(beneficiaries) is list and type(shares) is list, "LIST_INPUT")
        need(len(beneficiaries) == len(shares), "LENGTH_MISMATCH")
        need(2 <= len(beneficiaries) <= MAX_BENEFICIARIES, "BENEFICIARY_COUNT_2_8")
        need(all(is_lower_address(a) for a in beneficiaries), "ADDRESS_FORMAT")
        need(len(set(beneficiaries)) == len(beneficiaries), "DUPLICATE_BENEFICIARY")
        need(all(type(s) is int and 1 <= s <= MAX_SHARE for s in shares), "SHARE_RANGE")
        owner = str(gl.message.sender_address).lower()
        n = self.counts.get(owner, 0)
        need(n < MAX_SPLITS_PER_OWNER, "SPLIT_LIMIT")
        split_id = owner + ":" + str(n)
        need(not self.splits.get(split_id, ""), "ALREADY_EXISTS")
        split = {
            "id": split_id,
            "owner": owner,
            "beneficiaries": beneficiaries,
            "shares": shares,
            "total_shares": sum(shares),
            "state": "CREATED",
            "funded_wei": "0",
            "distribution_wei": [],
            "remainder_wei": "0",
            "remainder_to": beneficiaries[0],
        }
        self._save(split)
        self.counts[owner] = u32(n + 1)
        return split_id

    @gl.public.write.payable
    def fund(self, split_id: str) -> str:
        split = self._load(split_id)
        need(split["state"] == "CREATED", "NOT_CREATED")
        value = int(gl.message.value)
        need(value > 0, "FUND_MUST_SEND_GEN")
        split["funded_wei"] = str(value)
        split["state"] = "FUNDED"
        self._save(split)
        self.total_received = self.total_received + gl.message.value
        return pack({"id": split_id, "state": "FUNDED", "funded_wei": str(value)})

    @gl.public.write
    def distribute(self, split_id: str, claimed_json: str) -> str:
        split = self._load(split_id)
        need(split["state"] != "DISTRIBUTED", "ALREADY_DISTRIBUTED")
        need(split["state"] == "FUNDED", "NOT_FUNDED")
        need(len(claimed_json) <= 2000, "INPUT_BOUND")
        claimed = parse(claimed_json)
        n = len(split["beneficiaries"])
        need(type(claimed) is list and len(claimed) == n, "CLAIMED_LENGTH")
        need(all(type(a) is str and a.isdigit() for a in claimed), "CLAIMED_FORMAT")
        amounts = [int(a) for a in claimed]
        total = int(split["funded_wei"])
        need(sum(amounts) == total, "SUM_MISMATCH")
        expected, remainder = compute_distribution(total, split["shares"])
        need(amounts == expected, "DISTRIBUTION_MISMATCH")
        # Pay out immediately; every beneficiary is an EOA in the demo.
        # Amounts are fixed by the exact check above, so the payout
        # vector cannot differ from the recomputed vector.
        for addr, amount in zip(split["beneficiaries"], amounts):
            _Recipient(Address(addr)).emit_transfer(value=u256(amount))
        split["distribution_wei"] = [str(a) for a in amounts]
        split["remainder_wei"] = str(remainder)
        split["state"] = "DISTRIBUTED"
        self._save(split)
        self.total_distributed = self.total_distributed + u256(total)
        return pack({
            "id": split_id,
            "state": "DISTRIBUTED",
            "total_wei": str(total),
            "distribution_wei": [str(a) for a in amounts],
            "remainder_wei": str(remainder),
            "remainder_to": split["beneficiaries"][0],
        })

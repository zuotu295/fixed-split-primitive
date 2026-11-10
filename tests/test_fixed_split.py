"""Local mock tests for FixedSplit. NOT chain consensus evidence.

The real contract source (contracts/fixed_split.py) is imported with a
stubbed `genlayer` module, the same pattern used by the reference
primitives: the host fakes the VM (message, balance, transfers) so the
contract's deterministic logic can be exercised locally. Passing here
proves the arithmetic and the guards in this file; on-chain proof comes
only from the FINALIZED transactions in evidence.json.
"""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

GEN = 10 ** 18


class Map(dict):
    @classmethod
    def __class_getitem__(cls, value):
        return cls


class _Write:
    def __call__(self, f):
        return f

    def payable(self, f):
        return f


identity = lambda f: f


class UserError(Exception):
    pass


host = types.SimpleNamespace(
    Contract=object,
    public=types.SimpleNamespace(view=identity, write=_Write()),
    message=types.SimpleNamespace(sender_address="0x" + "1" * 40, value=0),
    evm=types.SimpleNamespace(contract_interface=identity),
    vm=types.SimpleNamespace(UserError=UserError, Return=object),
    nondet=types.SimpleNamespace(),
)
sdk = types.ModuleType("genlayer")
sdk.gl, sdk.TreeMap, sdk.u32, sdk.u256 = host, Map, int, int
sdk.Address = lambda a: a
sys.modules["genlayer"] = sdk

spec = importlib.util.spec_from_file_location(
    "fixed_split", Path(__file__).parents[1] / "contracts" / "fixed_split.py"
)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

# Fake the VM's push-payment: record transfers instead of executing them.
TRANSFERS = []


def _fake_init(self, addr):
    self._addr = addr


def _fake_emit_transfer(self, value=None):
    TRANSFERS.append((self._addr, int(value)))


r._Recipient.__init__ = _fake_init
r._Recipient.emit_transfer = _fake_emit_transfer

A = "0x" + "a" * 40
B = "0x" + "b" * 40
C = "0x" + "c" * 40
CREATOR = "0x" + "1" * 40


def expect_error(fn, code):
    with unittest.TestCase().assertRaises(UserError) as ctx:
        fn()
    assert code in str(ctx.exception), f"expected {code}, got {ctx.exception}"


class SplitTests(unittest.TestCase):
    def setUp(self):
        TRANSFERS.clear()
        host.message.sender_address = CREATOR
        host.message.value = 0
        self.c = r.FixedSplit()
        self.c.splits, self.c.counts = Map(), Map()
        self.c.total_received = 0
        self.c.total_distributed = 0
        self.c.balance = 0
        self.sid = self.c.create_split(json.dumps([A, B, C]), json.dumps([50, 30, 20]))

    def fund_100(self):
        host.message.value = 100 * GEN
        self.c.fund(self.sid)
        self.c.balance = 100 * GEN
        host.message.value = 0

    def test_protocol(self):
        p = json.loads(self.c.get_protocol())
        self.assertEqual(p["protocol"], "fixedsplit-1")
        self.assertEqual(p["remainder_rule"], "remainder_to_first_beneficiary")
        self.assertEqual(p["states"], ["CREATED", "FUNDED", "DISTRIBUTED"])

    def test_create_happy(self):
        s = json.loads(self.c.get_split(self.sid))
        self.assertEqual(s["state"], "CREATED")
        self.assertEqual(s["total_shares"], 100)
        self.assertEqual(s["beneficiaries"], [A, B, C])
        self.assertEqual(s["remainder_to"], A)

    def test_create_validation(self):
        expect_error(lambda: self.c.create_split(json.dumps([A, A]), json.dumps([1, 1])), "DUPLICATE_BENEFICIARY")
        expect_error(lambda: self.c.create_split(json.dumps(["0x" + "A" * 40, B]), json.dumps([1, 1])), "ADDRESS_FORMAT")
        expect_error(lambda: self.c.create_split(json.dumps([A]), json.dumps([1])), "BENEFICIARY_COUNT_2_8")
        expect_error(lambda: self.c.create_split(json.dumps([A, B]), json.dumps([0, 1])), "SHARE_RANGE")
        expect_error(lambda: self.c.create_split(json.dumps([A, B, C]), json.dumps([1, 1])), "LENGTH_MISMATCH")
        expect_error(lambda: self.c.create_split(json.dumps([A, B]), json.dumps([1000001, 1])), "SHARE_RANGE")

    def test_compute_distribution(self):
        # 101 GEN at 50/30/20 divides exactly in wei (50.5 / 30.3 / 20.2
        # GEN are whole wei amounts), so the remainder is 0, not 1 GEN:
        # the indivisible unit is the wei, not the GEN.
        amounts, rem = r.compute_distribution(101 * GEN, [50, 30, 20])
        self.assertEqual(amounts, [505 * GEN // 10, 303 * GEN // 10, 202 * GEN // 10])
        self.assertEqual(rem, 0)
        amounts, rem = r.compute_distribution(100 * GEN, [50, 30, 20])
        self.assertEqual(amounts, [50 * GEN, 30 * GEN, 20 * GEN])
        self.assertEqual(rem, 0)
        # 100 GEN at 1/1/1: floors are 33 GEN + 333333333333333333 wei
        # each; the 1 wei remainder goes to the first beneficiary.
        amounts, rem = r.compute_distribution(100 * GEN, [1, 1, 1])
        self.assertEqual(amounts, [100 * GEN // 3 + 1, 100 * GEN // 3, 100 * GEN // 3])
        self.assertEqual(rem, 1)
        for total in [1, 2, 3, 7, 99, 100, 101, 10 ** 20]:
            for shares in ([1, 1], [50, 30, 20], [7, 3], [1, 2, 3, 4]):
                amounts, _ = r.compute_distribution(total, shares)
                self.assertEqual(sum(amounts), total, f"sum != total for {total} {shares}")

    def test_fund_guards(self):
        expect_error(lambda: self.c.distribute(self.sid, json.dumps([str(50 * GEN), str(30 * GEN), str(20 * GEN)])), "NOT_FUNDED")
        host.message.value = 0
        expect_error(lambda: self.c.fund(self.sid), "FUND_MUST_SEND_GEN")
        host.message.value = 100 * GEN
        out = json.loads(self.c.fund(self.sid))
        self.assertEqual(out["state"], "FUNDED")
        self.assertEqual(out["funded_wei"], str(100 * GEN))
        host.message.value = 0
        expect_error(lambda: self.c.fund(self.sid), "NOT_CREATED")

    def test_distribute_bad_vectors_fail_without_state_change(self):
        self.fund_100()
        good = [str(50 * GEN), str(30 * GEN), str(20 * GEN)]
        # 1 GEN moved from the first to the second beneficiary: same sum,
        # wrong vector. Only element-wise equality catches this.
        expect_error(
            lambda: self.c.distribute(self.sid, json.dumps([str(49 * GEN), str(31 * GEN), str(20 * GEN)])),
            "DISTRIBUTION_MISMATCH",
        )
        # Off by one wei: sum breaks too.
        expect_error(
            lambda: self.c.distribute(self.sid, json.dumps([str(50 * GEN), str(30 * GEN), str(20 * GEN - 1)])),
            "SUM_MISMATCH",
        )
        # Wrong length / bad format.
        expect_error(lambda: self.c.distribute(self.sid, json.dumps(good[:2])), "CLAIMED_LENGTH")
        expect_error(lambda: self.c.distribute(self.sid, json.dumps(["51", "30", "20x"])), "CLAIMED_FORMAT")
        s = json.loads(self.c.get_split(self.sid))
        self.assertEqual(s["state"], "FUNDED")
        self.assertEqual(s["distribution_wei"], [])
        self.assertEqual(TRANSFERS, [])

    def test_distribute_good_pays_exactly_and_is_terminal(self):
        self.fund_100()
        out = json.loads(self.c.distribute(
            self.sid, json.dumps([str(50 * GEN), str(30 * GEN), str(20 * GEN)])))
        self.assertEqual(out["state"], "DISTRIBUTED")
        self.assertEqual(out["remainder_wei"], "0")
        self.assertEqual(out["remainder_to"], A)
        self.assertEqual(
            TRANSFERS, [(A, 50 * GEN), (B, 30 * GEN), (C, 20 * GEN)])
        self.c.balance = 0
        s = json.loads(self.c.get_split(self.sid))
        self.assertEqual(s["state"], "DISTRIBUTED")
        self.assertEqual(s["distribution_wei"], [str(50 * GEN), str(30 * GEN), str(20 * GEN)])
        totals = json.loads(self.c.get_totals())
        self.assertEqual(totals["total_received_wei"], str(100 * GEN))
        self.assertEqual(totals["total_distributed_wei"], str(100 * GEN))
        self.assertEqual(totals["contract_balance_wei"], "0")
        self.assertTrue(totals["invariant_ok"])
        expect_error(
            lambda: self.c.distribute(self.sid, json.dumps([str(50 * GEN), str(30 * GEN), str(20 * GEN)])),
            "ALREADY_DISTRIBUTED",
        )
        self.assertEqual(len(TRANSFERS), 3, "repeat distribute must not pay again")

    def test_distribute_remainder_goes_to_first(self):
        # Second split, same beneficiaries, shares 1/1/1 on 100 GEN:
        # the 1 wei remainder lands on the first beneficiary only.
        sid2 = self.c.create_split(json.dumps([A, B, C]), json.dumps([1, 1, 1]))
        host.message.value = 100 * GEN
        self.c.fund(sid2)
        host.message.value = 0
        floor = 100 * GEN // 3
        out = json.loads(self.c.distribute(
            sid2, json.dumps([str(floor + 1), str(floor), str(floor)])))
        self.assertEqual(out["remainder_wei"], "1")
        self.assertEqual(out["remainder_to"], A)
        self.assertEqual(TRANSFERS, [(A, floor + 1), (B, floor), (C, floor)])
        self.assertEqual(sum(a for _, a in TRANSFERS), 100 * GEN)


if __name__ == "__main__":
    unittest.main()

"""Merkle 트리 — 구성, 포함 증명, 변조 탐지, 도메인 분리."""

import hashlib

import pytest

from talkfile_engine.merkle import (
    EMPTY_ROOT,
    MerkleTree,
    build_tree,
    canonical_json,
    hash_leaf,
    hash_node,
    user_commit,
    verify_proof,
)


def _payloads(n):
    return [{"v": 1, "kind": "entry", "user_commit": f"{i:064x}", "weight": str(100 + i), "ap": i * 100} for i in range(n)]


class TestConstruction:
    def test_empty_tree(self):
        assert MerkleTree([]).root == EMPTY_ROOT

    def test_single_leaf_root_is_leaf(self):
        tree, hashes = build_tree(_payloads(1))
        assert tree.root == hashes[0]

    def test_two_leaves(self):
        tree, (a, b) = build_tree(_payloads(2))
        assert tree.root == hash_node(a, b)

    def test_odd_leaf_is_promoted_not_duplicated(self):
        tree, (a, b, c) = build_tree(_payloads(3))
        assert tree.root == hash_node(hash_node(a, b), c)
        # 마지막 잎 복제 방식(취약)과 다른 루트여야 한다
        assert tree.root != hash_node(hash_node(a, b), hash_node(c, c))

    def test_leaf_and_node_domains_differ(self):
        payload = {"x": 1}
        raw = canonical_json(payload)
        assert hash_leaf(payload) != hashlib.sha256(raw).hexdigest()
        assert hash_leaf(payload) == hashlib.sha256(b"\x00" + raw).hexdigest()

    def test_canonical_json_is_order_independent(self):
        assert canonical_json({"b": 1, "a": "가"}) == canonical_json({"a": "가", "b": 1})
        assert canonical_json({"a": 1}) == b'{"a":1}'

    def test_rejects_bad_leaf(self):
        with pytest.raises(ValueError):
            MerkleTree(["abc"])


class TestProofs:
    @pytest.mark.parametrize("n", [1, 2, 3, 4, 5, 7, 8, 9, 16, 33, 100, 257])
    def test_every_leaf_proves(self, n):
        tree, hashes = build_tree(_payloads(n))
        for i, h in enumerate(hashes):
            assert verify_proof(h, tree.proof(i), tree.root)

    def test_proof_as_dicts(self):
        tree, hashes = build_tree(_payloads(10))
        proof = [s.to_dict() for s in tree.proof(6)]
        assert verify_proof(hashes[6], proof, tree.root)

    def test_proof_length_is_logarithmic(self):
        tree, _ = build_tree(_payloads(1024))
        assert len(tree.proof(0)) == 10

    def test_wrong_leaf_fails(self):
        tree, hashes = build_tree(_payloads(10))
        assert not verify_proof(hashes[3], tree.proof(4), tree.root)

    def test_bad_side_fails(self):
        tree, hashes = build_tree(_payloads(4))
        assert not verify_proof(hashes[0], [{"side": "X", "hash": hashes[1]}], tree.root)

    def test_out_of_range(self):
        tree, _ = build_tree(_payloads(3))
        with pytest.raises(IndexError):
            tree.proof(3)


class TestTamperDetection:
    def test_changing_weight_changes_root(self):
        payloads = _payloads(50)
        root = build_tree(payloads)[0].root
        payloads[17] = {**payloads[17], "weight": "999"}
        assert build_tree(payloads)[0].root != root

    def test_adding_entry_changes_root(self):
        payloads = _payloads(50)
        root = build_tree(payloads)[0].root
        assert build_tree(payloads + _payloads(51)[-1:])[0].root != root

    def test_removing_entry_changes_root(self):
        payloads = _payloads(50)
        root = build_tree(payloads)[0].root
        assert build_tree(payloads[:-1])[0].root != root

    def test_reordering_changes_root(self):
        payloads = _payloads(8)
        root = build_tree(payloads)[0].root
        swapped = payloads[:]
        swapped[0], swapped[1] = swapped[1], swapped[0]
        assert build_tree(swapped)[0].root != root


class TestUserCommit:
    def test_commit_hides_user_and_binds_salt(self):
        c1 = user_commit("pool", "user-1", "aa" * 16)
        assert "user-1" not in c1
        assert c1 != user_commit("pool", "user-1", "bb" * 16)
        assert c1 != user_commit("pool", "user-2", "aa" * 16)
        assert c1 == user_commit("pool", "user-1", "aa" * 16)

"""
Merkle Tree — 추첨 응모·결과 무결성 증명
========================================

응모 명단과 추첨 결과를 각각 하나의 Merkle 루트로 묶는다.

- 응모 트리: 응모 마감 시 확정하고 **추첨 전에** 루트를 공개한다.
  추첨 후에 명단을 넣거나 빼거나 가중치를 바꾸면 루트가 달라진다.
- 결과 트리: 추첨 후 각 응모의 결과(당첨/대기, 순번, 소각 AP)를 묶는다.
- 개인 포함 증명: 응모자는 자기 잎과 형제 해시 목록(증명 경로)만으로, 전체 명단을
  보지 않고도 "내 응모가 루트에 들어 있다"를 확인한다.

해시 규칙 (RFC 6962 방식의 도메인 분리):
    leaf = SHA-256(0x00 ‖ canonical_json(payload))
    node = SHA-256(0x01 ‖ left ‖ right)
    - 잎과 내부 노드의 접두사를 달리해 2차 원상(second-preimage) 공격을 막는다.
    - 홀수 개 층에서는 마지막 노드를 복제하지 않고 **그대로 위로 올린다**.
      (마지막 노드 복제 방식은 서로 다른 잎 목록이 같은 루트를 내는 취약점이 있다.)
    - 잎이 0개면 EMPTY_ROOT.

개인정보: 잎에는 user_id 대신 `user_commit = SHA-256(domain|pool|user|salt)` 를 넣는다.
salt 는 응모별 무작위 값으로 서버에 보관하고 본인에게만 내준다.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

LEAF_PREFIX = b"\x00"
NODE_PREFIX = b"\x01"
USER_COMMIT_DOMAIN = "pickket-user-commit-v1"
EMPTY_ROOT = hashlib.sha256(b"pickket-merkle-empty-v1").hexdigest()
TREE_ALGORITHM = "sha256-merkle-rfc6962-promote-v1"


def canonical_json(payload: dict) -> bytes:
    """키 정렬·공백 없는 JSON. 브라우저 검증기도 같은 규칙으로 만든다."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def hash_leaf(payload: dict) -> str:
    return hashlib.sha256(LEAF_PREFIX + canonical_json(payload)).hexdigest()


def hash_node(left: str, right: str) -> str:
    return hashlib.sha256(NODE_PREFIX + bytes.fromhex(left) + bytes.fromhex(right)).hexdigest()


def user_commit(pool_id: str, user_id: str, salt_hex: str) -> str:
    return hashlib.sha256(f"{USER_COMMIT_DOMAIN}|{pool_id}|{user_id}|{salt_hex}".encode()).hexdigest()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ProofStep:
    """증명 경로 한 단계. side 는 형제 노드가 놓인 쪽(L/R)."""

    side: str
    hash: str

    def to_dict(self) -> dict:
        return {"side": self.side, "hash": self.hash}


class MerkleTree:
    """잎 해시 목록(순서 고정)으로 만든 Merkle 트리."""

    def __init__(self, leaf_hashes: list[str]):
        for h in leaf_hashes:
            if len(h) != 64:
                raise ValueError("leaf hash must be 64 hex chars")
            bytes.fromhex(h)
        self.leaves: list[str] = list(leaf_hashes)
        self.levels: list[list[str]] = [self.leaves]
        level = self.leaves
        while len(level) > 1:
            nxt: list[str] = []
            for i in range(0, len(level), 2):
                if i + 1 < len(level):
                    nxt.append(hash_node(level[i], level[i + 1]))
                else:
                    nxt.append(level[i])  # 홀수 → 승격
            self.levels.append(nxt)
            level = nxt

    @property
    def root(self) -> str:
        if not self.leaves:
            return EMPTY_ROOT
        return self.levels[-1][0]

    def __len__(self) -> int:
        return len(self.leaves)

    def proof(self, index: int) -> list[ProofStep]:
        if index < 0 or index >= len(self.leaves):
            raise IndexError("leaf index out of range")
        steps: list[ProofStep] = []
        idx = index
        for level in self.levels[:-1]:
            sibling = idx ^ 1
            if sibling < len(level):
                side = "L" if sibling < idx else "R"
                steps.append(ProofStep(side=side, hash=level[sibling]))
            # 형제가 없으면(홀수 끝) 승격 — 단계 없음
            idx //= 2
        return steps


def verify_proof(leaf_hash: str, proof: list[ProofStep] | list[dict], root: str) -> bool:
    """잎 해시 + 증명 경로 → 루트 재계산 후 비교."""
    current = leaf_hash
    for step in proof:
        side = step["side"] if isinstance(step, dict) else step.side
        sibling = step["hash"] if isinstance(step, dict) else step.hash
        if side == "L":
            current = hash_node(sibling, current)
        elif side == "R":
            current = hash_node(current, sibling)
        else:
            return False
    return current == root


def build_tree(payloads: list[dict]) -> tuple[MerkleTree, list[str]]:
    """잎 payload 목록 → (트리, 잎 해시 목록). 순서는 호출자가 정한다."""
    hashes = [hash_leaf(p) for p in payloads]
    return MerkleTree(hashes), hashes

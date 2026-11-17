"use client";

/**
 * 공개 공정성 증명서 검증 페이지 (과업 WP9) — 증명서 PDF 의 QR·주최사 대시보드 '공개 검증 페이지'가 여기로 온다.
 *
 * 서버의 판정을 그대로 믿지 않고 **브라우저가 직접** 다시 계산한다.
 *   ① 증명서 내용 → 정규 JSON → SHA-256 = 내용 해시
 *   ② Ed25519 전자서명(공개키 /fairness/keys) — WebCrypto
 *   ③ 시드 커밋 = SHA-256({"domain","pool_id","server_seed"}) — 추첨 전에 공개된 값과 일치
 *   ④ 공개 잎 전체로 응모·결과 Merkle 루트 재계산 — 증명서의 루트와 일치
 *   ⑤ 진행 순서: 정책 고정 ≤ 시드 커밋 < 응모 루트 확정 ≤ 추첨
 *   ⑥ (로그인 시) 내 응모가 두 루트에 포함됐는지 — salt 로 user_commit 재계산 + 증명 경로
 *
 * 규칙은 엔진(talkfile_engine/merkle.py · weight_policy.py · lottery.py)과 같다.
 * ※ 과업 증빙용 공개 페이지라 문구는 한국어 단일로 둔다(다국어 키 미추가).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@pickket/lib";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface CertificateView {
  cert_no: string;
  payload: Record<string, Json> & {
    pool_id: string;
    event: { id: string; title: string };
    tier: { id: string; name: string };
    counts: Record<string, number>;
    entries_root: string;
    results_root: string;
    seed_commitment: string;
    server_seed: string | null;
    committed_at: string | null;
    entries_root_at: string | null;
    drawn_at: string | null;
    policy_locked_at: string | null;
    policy_hash: string;
    algorithm: string;
  };
  canonical_payload: string;
  payload_hash: string;
  signature: string;
  key_id: string;
  issued_at: string;
  checks: Record<string, boolean>;
}
interface Leaf {
  index: number;
  leaf_hash: string;
  payload: Record<string, Json>;
}
interface ProofPart {
  index: number;
  leaf_hash: string;
  payload: Record<string, Json>;
  proof: Array<{ side: "L" | "R"; hash: string }>;
  root: string;
}
interface MyProof {
  pool_id: string;
  user_id: string;
  salt: string;
  entries: ProofPart | null;
  results: ProofPart | null;
}

type CheckState = "pending" | "ok" | "fail" | "unsupported";

const ALGO: Record<string, string> = {
  efraimidis_spirakis_weighted_sampling: "가중 공정 추첨",
  weighted_allocation_v1: "가중 배분",
};
const RESULT: Record<string, string> = { won: "당첨", waitlisted: "대기", excluded: "제재 제외" };

// ───────── 엔진과 같은 규칙 ─────────

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
async function hashLeaf(payload: Record<string, Json>): Promise<string> {
  const body = enc.encode(canonical(payload));
  const buf = new Uint8Array(body.length + 1);
  buf[0] = 0x00;
  buf.set(body, 1);
  return sha256(buf);
}
async function hashNode(left: string, right: string): Promise<string> {
  const buf = new Uint8Array(65);
  buf[0] = 0x01;
  buf.set(fromHex(left), 1);
  buf.set(fromHex(right), 33);
  return sha256(buf);
}
async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return sha256(enc.encode("pickket-merkle-empty-v1"));
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await hashNode(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}
async function walkProof(leaf: string, proof: Array<{ side: string; hash: string }>): Promise<string> {
  let cur = leaf;
  for (const step of proof) cur = step.side === "L" ? await hashNode(step.hash, cur) : await hashNode(cur, step.hash);
  return cur;
}

// ───────── 화면 ─────────

export default function CertificatePage() {
  const { certNo } = useParams<{ certNo: string }>();
  const [view, setView] = useState<CertificateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { state: CheckState; detail?: string }>>({});
  const [mine, setMine] = useState<{ state: CheckState; detail: string; result?: string } | null>(null);

  const set = (key: string, state: CheckState, detail?: string) => setChecks((prev) => ({ ...prev, [key]: { state, detail } }));

  const verify = useCallback(async (cert: CertificateView) => {
    const p = cert.payload;
    // ① 내용 해시 — 서명 대상은 서버가 준 정규 문자열 그 자체다.
    //    JS 는 100.0 을 "100" 으로 쓰고 Python 은 "100.0" 으로 써서 다시 직렬화하면 바이트가 달라진다.
    //    그래서 (a) 정규 문자열의 해시 = 내용 해시, (b) 그 문자열을 풀면 화면의 내용과 값이 같다 — 둘 다 본다.
    const canon = cert.canonical_payload;
    const contentHash = await sha256(enc.encode(canon));
    const sameValues = canonical(JSON.parse(canon) as Json) === canonical(p as Json);
    set("content", sameValues && contentHash === cert.payload_hash ? "ok" : "fail", contentHash);
    // ② 전자서명
    try {
      const keys = (await api.get("/fairness/keys")).data as { key_id: string; public_key: string };
      const key = await crypto.subtle.importKey("raw", fromB64(keys.public_key), { name: "Ed25519" }, false, ["verify"]);
      const ok = keys.key_id === cert.key_id && (await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64(cert.signature), enc.encode(canon)));
      set("signature", ok ? "ok" : "fail", `키 ID ${keys.key_id}`);
    } catch {
      set("signature", "unsupported", "이 브라우저는 Ed25519 검증을 지원하지 않습니다(서버 대조 결과를 참고하세요)");
    }
    // ③ 시드 커밋
    if (p.server_seed) {
      const body = `{"domain": "pickket-lottery-commit-v2", "pool_id": "${p.pool_id}", "server_seed": ${p.server_seed}}`;
      const commit = await sha256(enc.encode(body));
      set("seed", commit === p.seed_commitment ? "ok" : "fail", `공개 시드 ${p.server_seed}`);
    } else {
      set("seed", "fail", "공개 시드가 없습니다");
    }
    // ④ Merkle 루트 재계산
    for (const kind of ["entries", "results"] as const) {
      try {
        const leaves = ((await api.get(`/fairness/pools/${p.pool_id}/leaves`, { params: { kind } })).data as { leaves: Leaf[] }).leaves;
        const hashes = await Promise.all(leaves.map((l) => hashLeaf(l.payload)));
        const tampered = leaves.filter((l, i) => l.leaf_hash !== hashes[i]).length;
        const root = await merkleRoot(hashes);
        const expected = kind === "entries" ? p.entries_root : p.results_root;
        set(kind, root === expected && tampered === 0 ? "ok" : "fail", `잎 ${leaves.length.toLocaleString("ko-KR")}개로 다시 계산`);
      } catch {
        set(kind, "fail", "공개 잎을 불러오지 못했습니다");
      }
    }
    // ⑤ 진행 순서
    const t = (v: string | null) => (v ? Date.parse(v) : NaN);
    const ordered =
      t(p.policy_locked_at) <= t(p.committed_at) + 1000 && t(p.committed_at) < t(p.entries_root_at) && t(p.entries_root_at) <= t(p.drawn_at);
    set("order", ordered ? "ok" : "fail");
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .get(`/fairness/certificates/${encodeURIComponent(certNo)}`)
      .then((res) => {
        if (!alive) return;
        setView(res.data as CertificateView);
        void verify(res.data as CertificateView);
      })
      .catch(() => alive && setError("증명서를 찾을 수 없습니다. 발급번호를 확인해 주세요."));
    return () => {
      alive = false;
    };
  }, [certNo, verify]);

  const checkMine = async () => {
    if (!view) return;
    setMine({ state: "pending", detail: "확인 중…" });
    try {
      const proof = (await api.get(`/fairness/pools/${view.payload.pool_id}/my-proof`)).data as MyProof;
      if (!proof.entries) throw new Error("응모 기록이 없습니다");
      const commitInput = `pickket-user-commit-v1|${proof.pool_id}|${proof.user_id}|${proof.salt}`;
      const commit = await sha256(enc.encode(commitInput));
      const leaf = await hashLeaf(proof.entries.payload);
      const inEntries = commit === proof.entries.payload.user_commit && (await walkProof(leaf, proof.entries.proof)) === view.payload.entries_root;
      let inResults = false;
      let result = "";
      if (proof.results) {
        const rleaf = await hashLeaf(proof.results.payload);
        inResults = proof.results.payload.entry_leaf === leaf && (await walkProof(rleaf, proof.results.proof)) === view.payload.results_root;
        result = RESULT[String(proof.results.payload.result)] ?? String(proof.results.payload.result);
      }
      setMine({
        state: inEntries && inResults ? "ok" : "fail",
        detail: inEntries && inResults ? "내 응모가 추첨 전 명단과 결과에 그대로 들어 있습니다." : "내 응모를 루트까지 이어 붙이지 못했습니다.",
        result,
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setMine({ state: "fail", detail: status === 401 ? "로그인한 뒤 확인할 수 있습니다." : "이 추첨에서 내 응모를 찾지 못했습니다." });
    }
  };

  const pdfUrl = useMemo(() => {
    const base = (api.defaults.baseURL ?? "").replace(/\/$/, "");
    return `${base}/fairness/certificates/${encodeURIComponent(certNo)}/pdf`;
  }, [certNo]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-24 text-center">
        <h1 className="text-2xl font-black">공정성 증명서</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div className="h-96 animate-pulse rounded-2xl bg-muted" />
      </main>
    );
  }

  const p = view.payload;
  const all = ["content", "signature", "seed", "entries", "results", "order"];
  const done = all.every((k) => checks[k] && checks[k].state !== "pending");
  const failed = all.some((k) => checks[k]?.state === "fail");

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <p className="text-sm font-semibold tracking-wide text-muted-foreground">PICKKET · 추첨 공정성 증명서</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">{view.cert_no}</h1>
      <p className="mt-2 text-muted-foreground">
        {p.event.title} · {p.tier.name} · {ALGO[p.algorithm] ?? p.algorithm}
      </p>

      <div
        className={`mt-8 rounded-2xl border p-5 ${!done ? "border-border bg-card" : failed ? "border-destructive/40 bg-destructive/5" : "border-pk-fair/40 bg-pk-fair/5"}`}
        role="status"
      >
        <p className="text-lg font-bold">
          {!done ? "이 브라우저에서 직접 검증하는 중…" : failed ? "일부 검증이 맞지 않습니다" : "브라우저에서 직접 검증했습니다 — 모두 일치"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">서버의 판정을 믿지 않고, 공개된 값으로 이 기기에서 다시 계산한 결과입니다.</p>
      </div>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["응모", p.counts.applicants],
          ["당첨", p.counts.winners],
          ["대기", p.counts.waitlisted],
          ["제재 제외", p.counts.excluded_by_sanction],
        ].map(([label, n]) => (
          <div key={String(label)} className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-black tabular-nums">{Number(n ?? 0).toLocaleString("ko-KR")}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 rounded-2xl border border-border bg-card p-5">
        <h2 className="font-bold">검증 항목</h2>
        <ul className="mt-4 space-y-3">
          <Check label="증명서 내용이 발급 당시 그대로" sub="정규 JSON → SHA-256 = 내용 해시" c={checks.content} />
          <Check label="피켓 전자서명 일치 (Ed25519)" sub="공개키로 서명 검증" c={checks.signature} />
          <Check label="추첨 시드가 응모 시작 때 공개한 커밋과 일치" sub="SHA-256(domain · pool · 공개 시드) = 시드 커밋" c={checks.seed} />
          <Check label="응모 명단 Merkle 루트 재계산 일치" sub="추첨 전에 고정된 명단" c={checks.entries} />
          <Check label="추첨 결과 Merkle 루트 재계산 일치" sub="당첨·대기·제외와 소각 AP" c={checks.results} />
          <Check label="진행 순서" sub="정책 고정 → 시드 커밋 → 명단 고정 → 추첨" c={checks.order} />
        </ul>
      </section>

      <section className="mt-6 rounded-2xl border border-border bg-card p-5">
        <h2 className="font-bold">내 응모 확인</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          이 추첨에 응모했다면, 내 응모가 명단에서 빠지거나 바뀌지 않았는지 확인할 수 있습니다. 다른 사람의 정보는 보이지 않습니다.
        </p>
        <button type="button" onClick={() => void checkMine()} className="mt-4 h-11 rounded-full bg-foreground px-5 text-sm font-semibold text-background">
          내 응모 확인
        </button>
        {mine ? (
          <p className={`mt-3 text-sm ${mine.state === "ok" ? "text-pk-fair" : mine.state === "fail" ? "text-destructive" : "text-muted-foreground"}`}>
            {mine.detail} {mine.result ? `(결과: ${mine.result})` : ""}
          </p>
        ) : null}
      </section>

      <section className="mt-6 space-y-2 rounded-2xl border border-border bg-card p-5 text-sm">
        <h2 className="mb-2 font-bold">무결성 값</h2>
        <Hash label="정책 해시" value={p.policy_hash} />
        <Hash label="시드 커밋" value={p.seed_commitment} />
        <Hash label="공개 시드" value={p.server_seed ?? "-"} />
        <Hash label="응모 Merkle 루트" value={p.entries_root} />
        <Hash label="결과 Merkle 루트" value={p.results_root} />
        <Hash label="서명" value={view.signature} />
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center rounded-full border border-border px-5 text-sm font-semibold">
          증명서 PDF
        </a>
      </div>
    </main>
  );
}

function Check({ label, sub, c }: { label: string; sub: string; c?: { state: CheckState; detail?: string } }) {
  const state = c?.state ?? "pending";
  const mark = { pending: "…", ok: "✓", fail: "✕", unsupported: "–" }[state];
  const tone = { pending: "bg-muted text-muted-foreground", ok: "bg-pk-fair/15 text-pk-fair", fail: "bg-destructive/15 text-destructive", unsupported: "bg-muted text-muted-foreground" }[state];
  return (
    <li className="flex gap-3">
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${tone}`} aria-hidden>
        {mark}
      </span>
      <div className="min-w-0">
        <p className="font-semibold">{label}</p>
        <p className="break-all text-xs text-muted-foreground">
          {sub}
          {c?.detail ? ` · ${c.detail}` : ""}
        </p>
      </div>
    </li>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-xs">{value}</span>
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { judgeCancellation } from "./cancellation-fee";
import { toRefundPolicyLines } from "./policy-display";

/** 라벨이 약속한 구간을 파싱해, 그 구간의 모든 정수 남은일수에서 실제 판정과 대조한다. */
function parseBand(label: string): { lo: number; hi: number } | null {
  if (label === "행사 당일") return { lo: -30, hi: 0 };
  if (label === "언제든") return { lo: -30, hi: 400 };
  let m = /^D-(\d+) ~ D-(\d+)$/.exec(label);
  if (m) return { lo: Number(m[2]), hi: Number(m[1]) };
  m = /^D-(\d+) 이내$/.exec(label);
  if (m) return { lo: -30, hi: Number(m[1]) };
  m = /^D-(\d+) 이전$/.exec(label);
  if (m) return { lo: Number(m[1]), hi: 400 };
  m = /^D-(\d+)$/.exec(label);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

const EVENT = "2026-08-19T22:00:00.000Z";
const at = (d: number) => new Date(Date.UTC(2026, 7, 19, 15) - (d - 0.5) * 86400000);

const CASES: Array<[string, Array<{ daysBefore: number; feePct: number }>]> = [
  ["단계1-당일만", [{ daysBefore: 0, feePct: 100 }]],
  ["단계1-비당일", [{ daysBefore: 7, feePct: 30 }]],
  ["연속안함", [{ daysBefore: 30, feePct: 0 }, { daysBefore: 2, feePct: 60 }, { daysBefore: 0, feePct: 100 }]],
  ["기본5단계", [{ daysBefore: 30, feePct: 0 }, { daysBefore: 7, feePct: 30 }, { daysBefore: 3, feePct: 50 }, { daysBefore: 1, feePct: 80 }, { daysBefore: 0, feePct: 100 }]],
  ["상한6단계", [0,1,2,3,7,30].map((d,i)=>({ daysBefore: d, feePct: [100,80,70,50,30,0][i]! }))],
  ["큰값", [{ daysBefore: 365, feePct: 10 }, { daysBefore: 0, feePct: 100 }]],
  ["전부0수수료", [{ daysBefore: 30, feePct: 0 }]],
];

describe("🔴 라벨 구간 ↔ 실제 판정 전수 대조", () => {
  it.each(CASES)("%s", (_name, tiers) => {
    const lines = toRefundPolicyLines(tiers);
    const mismatches: string[] = [];
    for (const line of lines) {
      const band = parseBand(line.label);
      if (!band) { mismatches.push(`라벨 파싱 실패: ${line.label}`); continue; }
      for (let d = band.lo; d <= Math.min(band.hi, 400); d += 1) {
        const actual = judgeCancellation(tiers, EVENT, at(d)).refundPct;
        if (actual !== line.refundPct) {
          mismatches.push(`"${line.label} ${line.refundPct}%" 인데 남은 ${d}일 실제 ${actual}%`);
          break;
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("모든 남은일수가 어떤 라벨 구간에는 속한다 — 빈 구멍이 없다", () => {
    for (const [name, tiers] of CASES) {
      const bands = toRefundPolicyLines(tiers).map((l) => parseBand(l.label)!).filter(Boolean);
      for (let d = -5; d <= 400; d += 1) {
        const covered = bands.some((b) => d >= b.lo && d <= b.hi);
        expect(covered, `${name}: 남은 ${d}일이 어떤 라벨에도 안 속함`).toBe(true);
      }
    }
  });
});

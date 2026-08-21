/**
 * 오류 바운더리는 **앱 컴포넌트를 import 하지 않는다** — 기계로 지킨다.
 *
 * ── 왜 ──
 * 이 파일들은 **이미 뭔가 깨진 뒤에** 그려진다. 지금 5개 전부 `next/link` 와 CSS 유틸
 * (`btn-gradient`)만 쓰고 **앱 컴포넌트 의존이 0** 이라, 디자인 시스템이 터진 상황에서도 그려진다.
 * `<Button>` 하나를 넣으면 이 파일들의 **첫 앱 컴포넌트 import** 가 되고, 그만큼 실패 확률이 는다.
 *
 * 바운더리가 렌더 중에 던지면 상위로 올라가는데, 라우트 그룹 바운더리의 상위는
 * `global-error.tsx` 이고 **그것마저 던지면 백화면**이다. 더 갈 곳이 없다.
 *
 * ── 왜 주석이 아니라 테스트인가 ──
 * 주석은 "아직 안 바꾼 것"과 구분이 안 돼 다음 사람의 일관성 정리에 지워진다.
 * 이 세션에서 반복해 확인한 형태다 — 기억이 아니라 구조로 남긴다.
 * 이 검사는 안 읽어도 잡는다.
 *
 * ── 통과 기준선은 0 이다 ──
 * 톱니가 아니다. 예외를 두려면 위 위험을 다시 판단하고 이 주석부터 고쳐야 한다.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = __dirname;

const BOUNDARIES = [
  "error.tsx",
  "global-error.tsx",
  path.join("(auth)", "error.tsx"),
  path.join("(dashboard)", "error.tsx"),
  path.join("(public)", "error.tsx"),
];

/** 앱 내부 모듈 import. 외부 패키지(`react`, `next/link`, `@sentry/nextjs`)는 대상이 아니다. */
const APP_IMPORT = /(?:^|\n)\s*import[\s\S]*?from\s+["'](@\/[^"']+|\.{1,2}\/[^"']+)["']/g;

function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("오류 바운더리 — 앱 컴포넌트 import 금지", () => {
  it("§0 대상 5개가 모두 실재한다 (경로 오타로 조용히 통과하지 않도록)", () => {
    for (const rel of BOUNDARIES) {
      expect(fs.existsSync(path.join(APP, rel)), `없음: ${rel}`).toBe(true);
    }
  });

  it("§0-A 판정 정규식이 동작한다 (합성 입력)", () => {
    const hit = (src: string) => [...src.matchAll(APP_IMPORT)].map((m) => m[1]);
    expect(hit(`import { Button } from "@/components/ui/button";`)).toEqual([
      "@/components/ui/button",
    ]);
    expect(hit(`import { X } from "./local";`)).toEqual(["./local"]);
    expect(hit(`import Link from "next/link";`)).toEqual([]);
    expect(hit(`import * as Sentry from "@sentry/nextjs";`)).toEqual([]);
    expect(hit(`import { useEffect } from "react";`)).toEqual([]);
    // 여러 줄로 늘어난 import 도 잡는다
    expect(hit(`import {\n  Button,\n} from "@/components/ui/button";`)).toEqual([
      "@/components/ui/button",
    ]);
  });

  for (const rel of BOUNDARIES) {
    it(`${rel} — 앱 내부 모듈을 import 하지 않는다`, () => {
      const src = stripComments(fs.readFileSync(path.join(APP, rel), "utf8"));
      const imports = [...src.matchAll(APP_IMPORT)].map((m) => m[1]);
      expect(
        imports,
        `${rel} 이 앱 모듈을 import 한다. 오류 바운더리는 이미 깨진 뒤에 그려지는 화면이라 ` +
          `의존을 늘리면 실패 확률만 오른다(상위는 global-error 이고 그것마저 던지면 백화면). ` +
          `CSS 유틸(btn-gradient) + next/link 로 해결할 것: ${imports.join(", ")}`,
      ).toEqual([]);
    });
  }
});

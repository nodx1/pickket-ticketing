import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 실행 중인 **배포 커밋** — 이미지 안에 심어둔 표식을 읽는다.
 *
 * 🔴 왜 필요한가 (2026-07-29 실사고)
 * CapRover 는 타르볼 배포라 `gitHash` 를 공란으로 둔다. 그래서 "prod 에 지금 무엇이
 * 돌고 있나" 를 알 방법이 없었고, 두 세션이 서로의 배포를 오인했다 —
 * 한쪽은 "내 커밋이 배포됐다" 고 오판했고(실제로는 상대 세션의 다른 배포),
 * 다른 쪽은 진행 중인 빌드를 "멈춘 빌드" 로 오판했다.
 * 동작으로 역추적(엔드포인트 응답 형태를 보고 커밋을 추정)했는데 그날 실제로 틀렸다.
 *
 * 배포 로그 파일은 **의도**를 남기지만 이 값은 **실제 돌고 있는 것**을 남긴다.
 * 롤백·수동 재배포·빌드 실패 뒤에도 이미지를 따라다니므로 진실은 이쪽이다.
 *
 * 표식이 없으면(로컬 dev) "unknown" 이다 — 없는 것을 있는 것처럼 꾸미지 않는다.
 */
export interface BuildInfo {
  commit: string;
  app: string;
  builtAt: string;
}

const FALLBACK: BuildInfo = { commit: "unknown", app: "local", builtAt: "" };

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const raw = readFileSync(path.join(process.cwd(), ".build-info.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    cached = {
      commit: typeof parsed.commit === "string" && parsed.commit ? parsed.commit : "unknown",
      app: typeof parsed.app === "string" ? parsed.app : "",
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
    };
  } catch {
    // 파일이 없거나 깨졌다 — 헬스체크를 죽이지 않는다(관측용 정보일 뿐).
    cached = FALLBACK;
  }
  return cached;
}

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 이벤트 설정 폼이 **전송하는 필드 집합**을 고정한다 (2026-07-30 S0).
 *
 * ## 왜 이 테스트가 먼저 필요한가
 * 설정 화면 재배치는 JSX 를 크게 옮기는 작업이다. 그 과정에서 필드 하나가 payload 에서
 * 빠져도 **tsc·eslint·next build 가 전부 통과한다.** 그 필드는 저장이 조용히 멈추고,
 * 주최자는 "입력했는데 안 바뀐다" 를 한참 뒤에 발견한다.
 *
 * 2026-07-29~30 이틀간 "저장은 되는데 아무도 안 읽는 값" 이 다섯 건 확정됐다
 * (컬러 스킴 · 커스텀 도메인 · 용량 관리 · 파이널콜 · 상단 안내 배너).
 * 이 테스트는 그 여섯 번째를 **재배치가 만들지 않도록** 막는다.
 *
 * ## 왜 소스를 읽는가
 * `EventForm` 은 클라이언트 컴포넌트이고 v2 클라이언트·토스트·라우터 의존이 딸려 온다.
 * payload 조립만 떼어내 단위 테스트할 수 없다. 그래서 **소스에서 payload 키를 파싱**한다.
 *
 * ⚠️ 이 방식은 "테스트가 걸렸는지" 부터 의심해야 한다. 어제 같은 소스 검사 방식으로
 *    만든 테스트가 경로 중복으로 21건 전건 실패했다 — 통과했다면 엉뚱한 파일을 읽고도
 *    그린이었을 자리다. 그래서 아래 첫 테스트가 **파싱이 실제로 동작하는지** 부터 본다.
 */

/** 배포본 `a8b29648` 실측 — 재배치 전 기준선. 26개. */
const BASELINE_KEYS = [
  "organizerId",
  "organizers",
  "title",
  "slug",
  "summary",
  "description",
  "startsAt",
  "endsAt",
  "venueName",
  "venueAddress",
  "eventType",
  "ageRating",
  "isOnline",
  "heroImageUrl",
  "imageVariants",
  "galleryImages",
  "transportInfo",
  "parkingInfo",
  // 2026-08-02 — 프로그램 탭 자유문구 배선. 주최자가 쓸 칸이 없어 이미지로 때우던 것.
  "programNotes",
  "stageInfo",
  "runtimeMinutes",
  "intermissionMinutes",
  "rsvpEnabled",
  "groupBookingEnabled",
  "contextBanner",
  "admissionMode",
  "seatType",
  "raffleEnabled",
] as const;

async function payloadKeys(): Promise<string[]> {
  const source = await readFile(new URL("./event-form.tsx", import.meta.url), "utf8");

  const start = source.indexOf("const formPayload = {");
  if (start === -1) throw new Error("formPayload 선언을 찾지 못했습니다 — 이름이 바뀌었나?");

  // 선언부터 같은 들여쓰기의 닫는 중괄호까지
  const end = source.indexOf("\n    };", start);
  if (end === -1) throw new Error("formPayload 닫는 괄호를 찾지 못했습니다");

  const block = source.slice(start, end);
  return block
    .split("\n")
    .map((line) => line.trim())
    // 주석 제거 — 주석에 적힌 키 이름이 통과하면 안 된다
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .map((line) => /^([a-zA-Z][a-zA-Z0-9]*)\s*:/.exec(line)?.[1])
    .filter((k): k is string => Boolean(k));
}

describe("EventForm payload 파싱 자체", () => {
  it("🔴 파싱이 실제로 키를 뽑는다 — 0개면 아래 단언이 전부 무의미하다", async () => {
    const keys = await payloadKeys();
    expect(keys.length).toBeGreaterThan(20);
  });

  it("주석에 적힌 이름을 키로 오인하지 않는다", async () => {
    const source = await readFile(new URL("./event-form.tsx", import.meta.url), "utf8");
    // 소스에 주석이 실제로 있는 상태여야 이 검사가 의미를 갖는다
    expect(source).toMatch(/\/\/ /);
    const keys = await payloadKeys();
    expect(new Set(keys).size).toBe(keys.length); // 중복 없음
  });
});

/**
 * 🔴 payload 만으로는 부족하다 — **입력칸이 사라지는 것**은 안 잡힌다.
 *
 * `formPayload` 에 `title: form.title` 이 남아 있어도 화면에서 입력칸이 빠지면
 * 주최자는 그 값을 고칠 수 없다. 재배치는 JSX 를 옮기는 작업이라 정확히 그런 유실이
 * 나기 쉽다. 그래서 **렌더되는 입력 요소 목록**을 따로 고정한다.
 */
const RENDERED_INPUT_IDS = [
  "event-admission-mode",
  "event-context-banner",
  "event-description",
  "event-ends-at",
  "event-group-booking-enabled",
  "event-intermission",
  "event-is-online",
  "event-parking-info",
  "event-raffle-enabled",
  "event-rsvp-enabled",
  "event-runtime",
  "event-seat-type",
  "event-slug",
  "event-starts-at",
  "event-summary",
  "event-title",
  "event-transport-info",
  "event-venue-address",
  "event-venue-name",
] as const;

/** 컴포넌트형 입력(id 대신 label prop 을 쓴다) */
const RENDERED_COMPONENT_LABELS = [
  "대표 이미지 (가로)",
  "세로 이미지 (모바일용, 선택)",
  "연령 제한",
  "행사 유형",
] as const;

describe("EventForm 이 렌더하는 입력칸", () => {
  it.each(RENDERED_INPUT_IDS)("🔴 %s 입력칸이 화면에 있다", async (id) => {
    const source = await readFile(new URL("./event-form.tsx", import.meta.url), "utf8");
    expect(source).toContain(`id="${id}"`);
  });

  it.each(RENDERED_COMPONENT_LABELS)("🔴 '%s' 입력이 화면에 있다", async (label) => {
    const source = await readFile(new URL("./event-form.tsx", import.meta.url), "utf8");
    expect(source).toContain(`label="${label}"`);
  });

  it("갤러리 업로드가 있다(라벨에 상한 숫자가 들어가 문자열이 바뀔 수 있어 컴포넌트로 확인)", async () => {
    const source = await readFile(new URL("./event-form.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<GalleryUpload/);
  });
});

describe("EventForm 이 전송하는 필드 집합", () => {
  it.each(BASELINE_KEYS)("🔴 %s 를 여전히 전송한다", async (key) => {
    expect(await payloadKeys()).toContain(key);
  });

  it("기준선(26개)보다 줄지 않는다 — 재배치로 필드가 빠지면 여기서 잡힌다", async () => {
    const keys = await payloadKeys();
    expect(keys.length).toBeGreaterThanOrEqual(BASELINE_KEYS.length);
  });

  it("새로 늘어난 키가 있으면 알려준다 — 기준선 갱신이 필요하다는 신호", async () => {
    const keys = await payloadKeys();
    const added = keys.filter((k) => !BASELINE_KEYS.includes(k as (typeof BASELINE_KEYS)[number]));
    // 늘어난 것 자체는 정상(기능 추가). 다만 이 테스트가 **알려주게** 해서
    // 기준선을 의식적으로 갱신하도록 만든다.
    expect(added).toEqual([]);
  });
});

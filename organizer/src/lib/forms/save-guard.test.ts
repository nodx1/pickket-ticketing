import { describe, expect, it } from "vitest";

import { canSaveEditor } from "./save-guard";

const READY = { loading: false, loadFailed: false, dirty: true, saving: false };

describe("canSaveEditor", () => {
  it("바뀐 게 있고 정상 로드됐으면 저장한다", () => {
    expect(canSaveEditor(READY)).toBe(true);
  });

  it("🔴 로드가 실패했으면 저장하지 않는다 — 화면 값이 서버의 실제 값을 덮어쓴다", () => {
    expect(canSaveEditor({ ...READY, loadFailed: true })).toBe(false);
  });

  it("🔴 로드 실패는 dirty 여도 막는다 — 뭔가 바꾼 순간이 가장 위험한 순간이다", () => {
    expect(canSaveEditor({ ...READY, loadFailed: true, dirty: true })).toBe(false);
  });

  it("🔴 로드 실패는 다른 조건이 다 정상이어도 막는다", () => {
    expect(canSaveEditor({ loading: false, loadFailed: true, dirty: true, saving: false })).toBe(false);
  });

  it("불러오는 중에는 저장하지 않는다", () => {
    expect(canSaveEditor({ ...READY, loading: true })).toBe(false);
  });

  it("저장 중 중복 제출을 막는다", () => {
    expect(canSaveEditor({ ...READY, saving: true })).toBe(false);
  });

  it("🔴 바뀐 게 없으면 저장하지 않는다 — 환불 규정은 이 가드가 없어 기본값 덮어쓰기가 가능했다", () => {
    expect(canSaveEditor({ ...READY, dirty: false })).toBe(false);
  });
});

/**
 * 설정 편집기의 **저장 가능 여부** 판정 — 여러 편집 카드가 공유한다.
 *
 * ## 🔴 왜 공용으로 뺐나 (2026-07-29, 같은 결함 세 번째)
 * 설정 화면의 편집 카드들은 하나같이 이 모양이었다:
 *
 *     try { ...GET... } catch { /* ignore *\/ } finally { setLoading(false) }
 *
 * 로드가 실패해도 **화면은 정상처럼 보인다**. 상세 이미지는 "등록된 것 없음" 으로,
 * 환불 규정은 **하드코딩 기본값**(3일 전 50% · 당일 100%)으로 보인다.
 * 그 상태에서 저장을 누르면 서버의 실제 값이 그 화면 값으로 덮어써진다.
 * 환불 규정은 그대로 고객 분쟁이 되는 값이라 조용히 틀리면 안 된다.
 *
 * 판정을 순수 함수로 두는 이유는 컴포넌트 안에 있으면 테스트가 닿지 못해서다 —
 * 이 프로젝트에서 반복된 실패 유형이다.
 */
export interface EditorSaveState {
  /** 초기 값을 불러오는 중 */
  loading: boolean;
  /** 기존 값을 **못 읽은** 상태. 저장하면 덮어쓰므로 잠근다. */
  loadFailed: boolean;
  /** 사용자가 실제로 무언가 바꿨는가 */
  dirty: boolean;
  /** 저장 요청이 진행 중 */
  saving: boolean;
}

/**
 * 🔴 `loadFailed` 가 최우선이다. dirty 여도 막는다 —
 *    "한 장 추가해서 dirty 가 된 순간" 이 정확히 기존 값을 날리는 순간이다.
 */
export function canSaveEditor(state: EditorSaveState): boolean {
  if (state.loadFailed) return false;
  if (state.loading || state.saving) return false;
  return state.dirty;
}

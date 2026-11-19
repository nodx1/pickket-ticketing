/**
 * PWA(홈 화면 추가) 상태 — 피켓은 별도 네이티브 앱 없이 웹을 홈 화면에 설치해 쓴다.
 *
 * - 크롬·엣지·삼성 인터넷: `beforeinstallprompt` 를 붙잡아 두었다가 버튼에서 설치 창을 띄운다.
 *   이 이벤트는 페이지 로드 직후 한 번만 오므로 모듈 수준에서 일찍 구독해야 한다(initPwa).
 * - iOS 사파리: 설치 API 가 없어 「공유 → 홈 화면에 추가」 안내를 보여 준다.
 * - 카카오톡·인스타그램 등 인앱 브라우저: 설치가 불가능 → 외부 브라우저로 열도록 안내.
 * - 이미 홈 화면 앱으로 열린 경우(standalone): 아무것도 보이지 않는다.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type PwaPlatform = "standalone" | "ios" | "inapp" | "promptable" | "other";

export interface PwaState {
  platform: PwaPlatform;
  /** 이번 방문에서 설치를 마쳤는지 */
  installed: boolean;
}

const SERVER_STATE: PwaState = { platform: "other", installed: false };

let deferred: BeforeInstallPromptEvent | null = null;
let state: PwaState = SERVER_STATE;
let initialized = false;
const listeners = new Set<() => void>();

function emit(next: Partial<PwaState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const IN_APP_UA = /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER\(inapp|DaumApps|everytimeApp|Twitter/i;

export function detectPlatform(ua: string, standalone: boolean, canPrompt: boolean): PwaPlatform {
  if (standalone) return "standalone";
  if (IN_APP_UA.test(ua)) return "inapp";
  if (canPrompt) return "promptable";
  // iPadOS 13+ 는 데스크톱 사파리 UA 를 쓰므로 터치 지원으로 함께 판정한다(호출부에서 ua 에 반영).
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "other";
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function currentUa(): string {
  const ua = navigator.userAgent;
  const iPadDesktopUa = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return iPadDesktopUa ? `${ua} iPad` : ua;
}

function recompute() {
  emit({ platform: detectPlatform(currentUa(), isStandalone(), deferred !== null) });
}

/** 클라이언트에서 한 번만 호출한다(PwaProvider). */
export function initPwa() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 브라우저 기본 미니 배너 대신 피켓 버튼·배너에서 띄운다
    deferred = e as BeforeInstallPromptEvent;
    recompute();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit({ installed: true });
    recompute();
  });
  recompute();
}

export function subscribePwa(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPwaState(): PwaState {
  return state;
}

export function getServerPwaState(): PwaState {
  return SERVER_STATE;
}

/** 설치 창을 띄운다. 설치 창을 띄울 수 없는 환경이면 null. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  const ev = deferred;
  if (!ev) return null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  // 같은 이벤트는 다시 쓸 수 없다.
  deferred = null;
  if (outcome === "accepted") emit({ installed: true });
  recompute();
  return outcome;
}

/** 설치 버튼·배너를 보여 줄 플랫폼인지 */
export function canOfferInstall(p: PwaPlatform): boolean {
  return p === "promptable" || p === "ios" || p === "inapp";
}

/** 테스트 전용: 모듈 상태 초기화 */
export function __resetPwaForTest() {
  deferred = null;
  state = SERVER_STATE;
  initialized = false;
  listeners.clear();
}

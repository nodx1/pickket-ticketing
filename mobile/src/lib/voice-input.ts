/**
 * voice-input — expo-speech-recognition 동적 래퍼 (Phase B.1)
 *
 * dev client에 네이티브 모듈이 없을 때도 앱이 죽지 않도록
 * 런타임 require + try/catch 폴백. 모듈이 없으면 isAvailable=false.
 *
 * 설치 필요: `npx expo install expo-speech-recognition` + dev client 재빌드
 */

export interface VoiceResult {
  transcript: string;
  isFinal: boolean;
}

type Listener = (result: VoiceResult) => void;
type ErrorListener = (error: string) => void;

interface SpeechRecognitionModule {
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  start: (options: { lang?: string; interimResults?: boolean; continuous?: boolean }) => void;
  stop: () => void;
  addListener: (
    event: "result" | "error" | "end",
    listener: (payload: unknown) => void,
  ) => { remove: () => void };
}

let cachedModule: SpeechRecognitionModule | null | undefined;

function loadModule(): SpeechRecognitionModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    const mod = require("expo-speech-recognition") as {
      ExpoSpeechRecognitionModule?: SpeechRecognitionModule;
    };
    cachedModule = mod.ExpoSpeechRecognitionModule ?? null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    cachedModule = null;
  }
  return cachedModule;
}

export function isVoiceInputAvailable(): boolean {
  return loadModule() !== null;
}

export async function requestVoicePermission(): Promise<boolean> {
  const mod = loadModule();
  if (!mod) return false;
  try {
    const result = await mod.requestPermissionsAsync();
    return result.granted;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return false;
  }
}

export function startVoiceRecognition(options: {
  lang: string;
  onResult: Listener;
  onError: ErrorListener;
  onEnd: () => void;
}): () => void {
  const mod = loadModule();
  if (!mod) {
    options.onError("unavailable");
    return () => {};
  }

  const resultSub = mod.addListener("result", (payload) => {
    const p = payload as { results?: Array<{ transcript: string }>; isFinal?: boolean };
    const transcript = p.results?.[0]?.transcript ?? "";
    options.onResult({ transcript, isFinal: Boolean(p.isFinal) });
  });
  const errorSub = mod.addListener("error", (payload) => {
    const p = payload as { error?: string; message?: string };
    options.onError(p.error ?? p.message ?? "unknown");
  });
  const endSub = mod.addListener("end", () => options.onEnd());

  try {
    mod.start({ lang: options.lang, interimResults: true, continuous: false });
  } catch (err: unknown) {
    options.onError(err instanceof Error ? err.message : "start_failed");
  }

  return () => {
    try {
      mod.stop();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      // ignore
    }
    resultSub.remove();
    errorSub.remove();
    endSub.remove();
  };
}

/** 테스트 전용 — 모듈 캐시 초기화 */
export function __resetVoiceModuleCache(): void {
  cachedModule = undefined;
}

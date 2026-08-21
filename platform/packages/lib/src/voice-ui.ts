/**
 * P3-9: Voice UI — Browser-based voice search and commands.
 *
 * Uses Web Speech API for speech recognition and speech synthesis.
 * Provides hooks for React components to integrate voice interaction.
 */

// ── Web Speech API type declarations (not in all TS libs) ────────────────────

/* eslint-disable @typescript-eslint/no-empty-interface */
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

declare var SpeechRecognition: {
  new (): SpeechRecognition;
  prototype: SpeechRecognition;
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface VoiceCommand {
  intent: "search" | "navigate" | "purchase" | "help" | "unknown";
  query?: string;
  target?: string;
  confidence: number;
}

export interface VoiceUIOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onResult?: (command: VoiceCommand) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: VoiceState) => void;
}

export type VoiceState = "idle" | "listening" | "processing" | "speaking";

// ── Voice Recognition ────────────────────────────────────────────────────────

const COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  intent: VoiceCommand["intent"];
  extract: (match: RegExpMatchArray) => Partial<VoiceCommand>;
}> = [
  {
    pattern: /(?:검색|찾아|search|find)\s+(.+)/i,
    intent: "search",
    extract: (m) => ({ query: m[1]?.trim() }),
  },
  {
    pattern: /(?:이동|go|navigate)\s+(.+)/i,
    intent: "navigate",
    extract: (m) => ({ target: m[1]?.trim() }),
  },
  {
    pattern: /(?:구매|구입|사기|buy|purchase)\s*(.+)?/i,
    intent: "purchase",
    extract: (m) => ({ query: m[1]?.trim() }),
  },
  {
    pattern: /(?:도움|help|도움말)/i,
    intent: "help",
    extract: () => ({}),
  },
  {
    pattern: /(?:홈|메인|home|main)/i,
    intent: "navigate",
    extract: () => ({ target: "/" }),
  },
  {
    pattern: /(?:콘서트|concert|공연|이벤트|event)/i,
    intent: "search",
    extract: (m) => ({ query: m[0] }),
  },
];

function parseCommand(transcript: string): VoiceCommand {
  const text = transcript.trim();

  for (const { pattern, intent, extract } of COMMAND_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        intent,
        confidence: 0.8,
        ...extract(match),
      };
    }
  }

  // Default: treat as search query
  if (text.length > 1) {
    return {
      intent: "search",
      query: text,
      confidence: 0.5,
    };
  }

  return { intent: "unknown", confidence: 0.0 };
}

// ── Voice Manager Class ──────────────────────────────────────────────────────

export class VoiceManager {
  private recognition: SpeechRecognition | null = null;
  private synthesis: SpeechSynthesis | null = null;
  private state: VoiceState = "idle";
  private options: VoiceUIOptions;

  constructor(options: VoiceUIOptions = {}) {
    this.options = {
      lang: "ko-KR",
      continuous: false,
      interimResults: true,
      ...options,
    };

    if (typeof window !== "undefined") {
      const SpeechRecognitionCtor =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      if (SpeechRecognitionCtor) {
        this.recognition = new SpeechRecognitionCtor() as SpeechRecognition;
        this.recognition.lang = this.options.lang!;
        this.recognition.continuous = this.options.continuous!;
        this.recognition.interimResults = this.options.interimResults!;
        this._setupRecognition();
      }
      this.synthesis = window.speechSynthesis || null;
    }
  }

  get isSupported(): boolean {
    return this.recognition !== null;
  }

  get currentState(): VoiceState {
    return this.state;
  }

  start(): void {
    if (!this.recognition) {
      this.options.onError?.("음성 인식이 지원되지 않는 브라우저입니다");
      return;
    }
    try {
      this.recognition.start();
      this._setState("listening");
    } catch {
      // Already started
    }
  }

  stop(): void {
    if (this.recognition) {
      this.recognition.stop();
      this._setState("idle");
    }
  }

  speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.synthesis) {
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.options.lang || "ko-KR";
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      this._setState("speaking");

      utterance.onend = () => {
        this._setState("idle");
        resolve();
      };

      utterance.onerror = () => {
        this._setState("idle");
        resolve();
      };

      this.synthesis.speak(utterance);
    });
  }

  destroy(): void {
    this.stop();
    if (this.synthesis) {
      this.synthesis.cancel();
    }
  }

  private _setState(state: VoiceState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private _setupRecognition(): void {
    if (!this.recognition) return;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      const last = event.results[event.results.length - 1];
      if (!last) return;

      if (last.isFinal) {
        const transcript = last[0]?.transcript || "";
        this._setState("processing");
        const command = parseCommand(transcript);
        this.options.onResult?.(command);
        this._setState("idle");
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const errorMap: Record<string, string> = {
        "no-speech": "음성이 감지되지 않았습니다",
        "audio-capture": "마이크를 찾을 수 없습니다",
        "not-allowed": "마이크 권한이 필요합니다",
        network: "네트워크 오류가 발생했습니다",
      };
      this.options.onError?.(
        errorMap[event.error] || `음성 인식 오류: ${event.error}`,
      );
      this._setState("idle");
    };

    this.recognition.onend = () => {
      if (this.state === "listening" && this.options.continuous) {
        // Restart for continuous mode
        try {
          this.recognition?.start();
        } catch {
          this._setState("idle");
        }
      } else {
        this._setState("idle");
      }
    };
  }
}

// ── Utility: Voice feedback messages ─────────────────────────────────────────

export const VOICE_FEEDBACK = {
  search: (query: string) => `${query} 검색 결과를 보여드립니다`,
  navigate: (target: string) => `${target} 페이지로 이동합니다`,
  purchase: () => "구매 페이지를 열겠습니다",
  help: () =>
    "사용 가능한 명령: 검색, 이동, 구매, 도움말. 예를 들어 '콘서트 검색'이라고 말씀해 주세요.",
  unknown: () => "명령을 이해하지 못했습니다. 다시 말씀해 주세요.",
} as const;

export { parseCommand };

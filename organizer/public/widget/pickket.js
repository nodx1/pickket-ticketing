/**
 * PICKKET 티켓 위젯 Web Component
 * <pickket-ticket event-slug="my-event" theme-color="#6C5CE7" button-text="티켓 구매" />
 *
 * CSS Custom Properties:
 *   --pickket-primary: 메인 색상 (기본: #6C5CE7)
 *   --pickket-radius: 버튼 라운딩 (기본: 100px)
 *   --pickket-font: 폰트 패밀리 (기본: system-ui)
 */
(function () {
  "use strict";

  const DEFAULT_COLOR = "#6C5CE7";
  const DEFAULT_TEXT = "\uD2F0\uCF13 \uAD6C\uB9E4"; // 티켓 구매
  const CLOSE_TEXT = "\uB2EB\uAE30"; // 닫기

  class PickketTicket extends HTMLElement {
    static get observedAttributes() {
      return ["event-slug", "theme-color", "button-text", "api-base"];
    }

    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._overlayEl = null;
      this._iframeEl = null;
      this._config = null; // widget-config fetch 결과 캐시
      this._opening = false; // 오버레이 오픈 중복 방지
      this._boundMessageHandler = this._onMessage.bind(this);
    }

    connectedCallback() {
      this._render();
      window.addEventListener("message", this._boundMessageHandler);
      // 초기 로드 시 config 를 선반영 — isActive=false 면 버튼을 비활성/문구 변경.
      void this._loadConfig();
    }

    disconnectedCallback() {
      window.removeEventListener("message", this._boundMessageHandler);
      this._closeOverlay();
    }

    attributeChangedCallback() {
      if (this._shadow) this._render();
    }

    get eventSlug() {
      return this.getAttribute("event-slug") || "";
    }

    get themeColor() {
      return (
        getComputedStyle(this).getPropertyValue("--pickket-primary").trim() ||
        this.getAttribute("theme-color") ||
        DEFAULT_COLOR
      );
    }

    get buttonText() {
      return this.getAttribute("button-text") || DEFAULT_TEXT;
    }

    get borderRadius() {
      return (
        getComputedStyle(this).getPropertyValue("--pickket-radius").trim() ||
        "100px"
      );
    }

    get fontFamily() {
      return (
        getComputedStyle(this).getPropertyValue("--pickket-font").trim() ||
        "system-ui, -apple-system, sans-serif"
      );
    }

    get apiBase() {
      if (this.getAttribute("api-base")) return this.getAttribute("api-base");
      // 스크립트 원본 origin 추출
      try {
        const scripts = document.querySelectorAll('script[src*="pickket.js"]');
        if (scripts.length > 0) {
          const src = scripts[scripts.length - 1].src;
          const url = new URL(src);
          return url.origin;
        }
      } catch {
        // 무시
      }
      return window.location.origin;
    }

    _render() {
      // 서버 config theme 우선(있으면), 없으면 속성/CSS 변수 폴백.
      const theme = (this._config && this._config.theme) || {};
      const color = (typeof theme.primaryColor === "string" && theme.primaryColor) || this.themeColor;
      const disabled = this._config && (this._config.allowed === false || this._config.isActive === false);
      const text = disabled
        ? this._config.allowed === false
          ? "판매 채널 아님" // 판매 채널 아님
          : "판매 준비 중" // 판매 준비 중
        : (typeof theme.buttonText === "string" && theme.buttonText) || this.buttonText;
      const radius = this.borderRadius;
      const font = this.fontFamily;

      // 호버 색상 계산 (약간 밝게)
      const hoverColor = this._lightenColor(color, 15);

      this._shadow.innerHTML = /* html */ `
        <style>
          :host {
            display: inline-block;
          }
          .pickket-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 12px 28px;
            border: none;
            border-radius: ${radius};
            background: linear-gradient(135deg, ${color}, ${hoverColor});
            color: #fff;
            font-family: ${font};
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
            line-height: 1.4;
            white-space: nowrap;
          }
          .pickket-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 16px rgba(0,0,0,0.18);
          }
          .pickket-btn:active {
            transform: translateY(0);
          }
          .pickket-btn[disabled] {
            cursor: not-allowed;
            opacity: 0.55;
            filter: grayscale(0.4);
          }
          .pickket-btn[disabled]:hover {
            transform: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          }
          .pickket-btn svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
          }
        </style>
        <button class="pickket-btn" part="button"${disabled ? " disabled aria-disabled=\"true\"" : ""}>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4ZM13 17h-2v-2h2v2Zm0-4h-2v-2h2v2Zm0-4h-2V7h2v2Z"/>
          </svg>
          ${this._escapeHtml(text)}
        </button>
      `;

      if (!disabled) {
        this._shadow
          .querySelector(".pickket-btn")
          .addEventListener("click", () => this._openOverlay());
      }
    }

    /**
     * widget-config \uB97C fetch \uD574 \uC11C\uBC84\uCE21 \uB3C4\uBA54\uC778/isActive \uAC15\uC81C\uB97C \uD074\uB77C\uC774\uC5B8\uD2B8\uC5D0\uB3C4 \uBC18\uC601\uD55C\uB2E4.
     * - 403(\uB3C4\uBA54\uC778 \uBD88\uD5C8) \u2192 { allowed:false } \uB85C \uCE90\uC2DC, \uBC84\uD2BC \uBE44\uD65C\uC131.
     * - isActive=false \u2192 \uD310\uB9E4 \uC900\uBE44 \uC911, \uBC84\uD2BC \uBE44\uD65C\uC131.
     * \uC2E4\uD328(\uB124\uD2B8\uC6CC\uD06C/404 \uB4F1)\uB294 fail-open \uD558\uC9C0 \uC54A\uACE0 { allowed:false } \uB85C \uC548\uC804\uCE21 \uCC98\uB9AC\uD558\uB418,
     * \uC11C\uBC84 \uC790\uCCB4 \uAC15\uC81C(widget-config 403)\uAC00 \uCD5C\uC885 \uBC29\uC5B4\uC120\uC774\uBBC0\uB85C \uC5EC\uAE30\uC11C\uB294 UX \uD78C\uD2B8 \uBAA9\uC801\uC774\uB2E4.
     */
    async _loadConfig() {
      if (!this.eventSlug) return;
      try {
        const res = await fetch(
          `${this.apiBase}/api/public/events/${encodeURIComponent(this.eventSlug)}/widget-config`,
          { method: "GET" },
        );
        if (res.status === 403) {
          this._config = { allowed: false, isActive: false, reason: "domain" };
          this._render();
          return;
        }
        if (!res.ok) {
          // \uC774\uBCA4\uD2B8 \uBBF8\uACF5\uAC1C/\uC624\uB958 \u2014 \uC624\uD508 \uAC8C\uC774\uD2B8\uC5D0\uC11C \uC11C\uBC84\uAC00 \uCD5C\uC885 \uD310\uB2E8\uD558\uB3C4\uB85D \uB450\uB418 \uBC84\uD2BC\uC740 \uC720\uC9C0.
          this._config = { allowed: true, isActive: true, reason: "unknown-" + res.status };
          return;
        }
        const payload = await res.json();
        const data = (payload && payload.data) || {};
        this._config = {
          allowed: true,
          isActive: data.isActive !== false,
          theme: data.theme || null,
          reason: null,
        };
        this._render();
      } catch (_err) {
        // \uB124\uD2B8\uC6CC\uD06C \uC2E4\uD328 \u2014 \uC11C\uBC84 \uAC15\uC81C\uAC00 \uCD5C\uC885 \uBC29\uC5B4\uC120\uC774\uBBC0\uB85C \uBC84\uD2BC\uC740 \uC720\uC9C0(\uC624\uD508 \uC2DC iframe/\uC11C\uBC84\uAC00 \uC7AC\uAC80\uC99D).
        this._config = { allowed: true, isActive: true, reason: "network" };
      }
    }

    async _openOverlay() {
      if (!this.eventSlug) {
        console.warn("[pickket-ticket] event-slug \uC18D\uC131\uC774 \uD544\uC694\uD569\uB2C8\uB2E4");
        return;
      }
      if (this._overlayEl || this._opening) return;
      this._opening = true;
      try {
        // \uC624\uD508 \uC9C1\uC804 \uCD5C\uC2E0 config \uD655\uC778(\uC5F0\uACB0 \uC2E4\uD328 \uC2DC \uC774\uC804 \uCE90\uC2DC \uC720\uC9C0).
        if (!this._config) await this._loadConfig();
        if (this._config && this._config.allowed === false) {
          console.warn("[pickket-ticket] \uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uB3C4\uBA54\uC778"); // \uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uB3C4\uBA54\uC778
          return;
        }
        if (this._config && this._config.isActive === false) {
          console.warn("[pickket-ticket] \uD310\uB9E4 \uC900\uBE44 \uC911"); // \uD310\uB9E4 \uC900\uBE44 \uC911
          return;
        }
      } finally {
        this._opening = false;
      }

      const overlay = document.createElement("div");
      overlay.id = "pickket-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(4px)",
        animation: "pickket-fade-in 0.2s ease",
      });

      // 스타일 주입 (애니메이션)
      if (!document.getElementById("pickket-overlay-style")) {
        const style = document.createElement("style");
        style.id = "pickket-overlay-style";
        style.textContent = `
          @keyframes pickket-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes pickket-slide-up {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `;
        document.head.appendChild(style);
      }

      // 컨테이너
      const container = document.createElement("div");
      Object.assign(container.style, {
        position: "relative",
        width: "100%",
        maxWidth: "480px",
        height: "90vh",
        maxHeight: "800px",
        borderRadius: "16px",
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 24px 48px rgba(0,0,0,0.2)",
        animation: "pickket-slide-up 0.3s ease",
        margin: "0 16px",
      });

      // 닫기 버튼
      const closeBtn = document.createElement("button");
      closeBtn.setAttribute("aria-label", CLOSE_TEXT);
      closeBtn.textContent = "\u2715";
      Object.assign(closeBtn.style, {
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "10",
        width: "36px",
        height: "36px",
        border: "none",
        borderRadius: "50%",
        background: "rgba(0,0,0,0.08)",
        color: "#333",
        fontSize: "18px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 0.15s",
      });
      closeBtn.addEventListener("mouseenter", function () {
        this.style.background = "rgba(0,0,0,0.15)";
      });
      closeBtn.addEventListener("mouseleave", function () {
        this.style.background = "rgba(0,0,0,0.08)";
      });
      closeBtn.addEventListener("click", () => this._closeOverlay());

      // iframe
      const iframe = document.createElement("iframe");
      const embedUrl = `${this.apiBase}/embed/${encodeURIComponent(this.eventSlug)}?source=widget`;
      iframe.src = embedUrl;
      iframe.setAttribute("allow", "payment");
      iframe.setAttribute("loading", "lazy");
      // 결제/티켓 UI 격리: same-origin은 우리 도메인 콘텐츠이므로 유지, top-navigation은 PG 리디렉션 위해 허용
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
      );
      iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
      Object.assign(iframe.style, {
        width: "100%",
        height: "100%",
        border: "none",
      });

      container.appendChild(closeBtn);
      container.appendChild(iframe);
      overlay.appendChild(container);

      // 백드롭 클릭으로 닫기
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this._closeOverlay();
      });

      // ESC 키로 닫기
      this._escKeyHandler = (e) => {
        if (e.key === "Escape") this._closeOverlay();
      };
      document.addEventListener("keydown", this._escKeyHandler);

      document.body.appendChild(overlay);
      document.body.style.overflow = "hidden";
      this._overlayEl = overlay;
      this._iframeEl = iframe;
    }

    _closeOverlay() {
      if (this._overlayEl) {
        this._overlayEl.remove();
        this._overlayEl = null;
        this._iframeEl = null;
        document.body.style.overflow = "";
      }
      if (this._escKeyHandler) {
        document.removeEventListener("keydown", this._escKeyHandler);
        this._escKeyHandler = null;
      }
    }

    _onMessage(event) {
      // iframe에서 온 메시지만 처리
      if (!this._iframeEl) return;

      // 보안: source / origin 이중 검증 — 부모 페이지 악성 스크립트의 이벤트 위조 차단
      if (event.source !== this._iframeEl.contentWindow) return;
      let expectedOrigin;
      try {
        expectedOrigin = new URL(this.apiBase).origin;
      } catch {
        return;
      }
      if (event.origin !== expectedOrigin) return;

      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }

      if (data && data.type === "pickket:order-complete") {
        const orderId = typeof data.orderId === "string" ? data.orderId : null;
        const shortId = typeof data.shortId === "string" ? data.shortId : null;
        const totalAmount = typeof data.totalAmount === "number" ? data.totalAmount : 0;
        this.dispatchEvent(
          new CustomEvent("pickket:order-complete", {
            bubbles: true,
            composed: true,
            detail: { orderId, shortId, totalAmount },
          }),
        );
        // 주문 완료 후 오버레이 닫기
        setTimeout(() => this._closeOverlay(), 1500);
      }
    }

    _lightenColor(hex, percent) {
      const num = parseInt(hex.replace("#", ""), 16);
      const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(2.55 * percent));
      const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(2.55 * percent));
      const b = Math.min(255, (num & 0xff) + Math.round(2.55 * percent));
      return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
    }

    _escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }
  }

  if (!customElements.get("pickket-ticket")) {
    customElements.define("pickket-ticket", PickketTicket);
  }
})();

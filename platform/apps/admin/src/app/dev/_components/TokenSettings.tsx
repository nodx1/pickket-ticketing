"use client";

import { useState, useEffect } from "react";
import { Key, Plus, Trash2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface TokenInfo {
  developer: string;
  created_at: string;
  token_prefix: string;
}

const MCP_SERVER =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "https://mcp-staging.pickket.kr";

export function TokenSettings() {
  const t = useTranslations("dev.tokenSettings");
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDev, setNewDev] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [adminKeyInput, setAdminKeyInput] = useState(
    typeof window !== "undefined"
      ? (sessionStorage.getItem("pickket_admin_key") ?? "")
      : "",
  );
  const [myTokenInput, setMyTokenInput] = useState(
    typeof window !== "undefined"
      ? (sessionStorage.getItem("pickket_mcp_token") ?? "")
      : "",
  );

  const adminKey =
    typeof window !== "undefined"
      ? (sessionStorage.getItem("pickket_admin_key") ?? "")
      : "";

  const fetchTokens = async () => {
    try {
      const r = await fetch(`${MCP_SERVER}/api/tokens`, {
        headers: { "X-Admin-Key": adminKey },
      });
      const d = await r.json();
      setTokens(d.tokens ?? []);
    } catch {
      toast.error(t("fetchError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokens();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!newDev.trim()) return;
    try {
      const r = await fetch(`${MCP_SERVER}/api/tokens`, {
        method: "POST",
        headers: {
          "X-Admin-Key": adminKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ developer: newDev.trim() }),
      });
      const d = await r.json();
      setNewToken(d.token);
      setNewDev("");
      await fetchTokens();
    } catch {
      toast.error(t("createError"));
    }
  };

  const handleRevoke = async (prefix: string) => {
    try {
      await fetch(`${MCP_SERVER}/api/tokens/${prefix}`, {
        method: "DELETE",
        headers: { "X-Admin-Key": adminKey },
      });
      toast.success(t("revokeSuccess"));
      await fetchTokens();
    } catch {
      toast.error(t("revokeError"));
    }
  };

  const handleCopy = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      {/* 키 설정 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--pk-text)]">
          {t("authSettingsTitle")}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[var(--pk-text-secondary)] mb-1 block">
              {t("adminKeyLabel")}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder={t("adminKeyPlaceholder")}
                value={adminKeyInput}
                onChange={(e) => setAdminKeyInput(e.target.value)}
                className="flex-1 rounded-lg border border-[var(--pk-border)] bg-[var(--pk-bg)] px-3 py-2 text-sm text-[var(--pk-text)] placeholder:text-[var(--pk-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--pk-accent)]"
              />
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem("pickket_admin_key", adminKeyInput);
                  toast.success(t("adminKeySaved"));
                }}
                className="rounded-lg bg-[var(--pk-accent)] px-3 py-2 text-sm font-medium text-white"
              >
                {t("save")}
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-[var(--pk-text-secondary)] mb-1 block">
              {t("myTokenLabel")}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder={t("myTokenPlaceholder")}
                value={myTokenInput}
                onChange={(e) => setMyTokenInput(e.target.value)}
                className="flex-1 rounded-lg border border-[var(--pk-border)] bg-[var(--pk-bg)] px-3 py-2 text-sm text-[var(--pk-text)] placeholder:text-[var(--pk-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--pk-accent)]"
              />
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem("pickket_mcp_token", myTokenInput);
                  toast.success(t("myTokenSaved"));
                }}
                className="rounded-lg bg-[var(--pk-accent)] px-3 py-2 text-sm font-medium text-white"
              >
                {t("save")}
              </button>
            </div>
            <p className="text-xs text-[var(--pk-text-secondary)] mt-1">
              {t("myTokenHint")}
            </p>
          </div>
        </div>
      </div>

      {/* 신규 토큰 발급 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--pk-text)] flex items-center gap-2">
          <Plus className="h-4 w-4" />
          {t("issueTitle")}
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t("devNamePlaceholder")}
            value={newDev}
            onChange={(e) => setNewDev(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1 rounded-lg border border-[var(--pk-border)] bg-[var(--pk-bg)] px-3 py-2 text-sm text-[var(--pk-text)] placeholder:text-[var(--pk-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--pk-accent)]"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newDev.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--pk-accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Key className="h-3.5 w-3.5" />
            {t("issue")}
          </button>
        </div>

        {/* 발급된 토큰 표시 (1회) */}
        {newToken && (
          <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-3 space-y-2">
            <p className="text-xs font-medium text-green-600">
              {t("newTokenNotice")}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-[var(--pk-text)] bg-[var(--pk-bg)] rounded px-2 py-1 truncate">
                {newToken}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 p-1.5 rounded-lg border border-[var(--pk-border)] hover:bg-[var(--pk-bg)]"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setNewToken(null)}
              className="text-xs text-[var(--pk-text-secondary)] hover:underline"
            >
              {t("close")}
            </button>
          </div>
        )}
      </div>

      {/* 토큰 목록 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-[var(--pk-text-secondary)]">
            {t("loading")}
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-6 text-center text-sm text-[var(--pk-text-secondary)]">
            {t("emptyTokens")}
          </div>
        ) : (
          <div className="divide-y divide-[var(--pk-border)]">
            {tokens.map((tok, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Key className="h-4 w-4 text-[var(--pk-text-secondary)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--pk-text)]">
                    {tok.developer}
                  </p>
                  <p className="text-xs text-[var(--pk-text-secondary)] font-mono">
                    {tok.token_prefix}
                  </p>
                </div>
                <span className="text-xs text-[var(--pk-text-secondary)] shrink-0">
                  {tok.created_at
                    ? new Date(tok.created_at).toLocaleDateString("ko-KR")
                    : "-"}
                </span>
                <button
                  type="button"
                  onClick={() => handleRevoke(tok.token_prefix)}
                  className="shrink-0 p-1.5 rounded-lg text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

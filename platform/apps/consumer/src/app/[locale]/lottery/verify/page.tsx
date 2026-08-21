"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@pickket/lib";

interface VerificationResult {
  pool_id: string;
  commitment_hash: string;
  seed_used: number;
  algorithm: string;
  total_applicants: number;
  total_seats: number;
  verification_data: Record<string, unknown>;
  is_valid: boolean;
}

interface TransparencyReport {
  pool_id: string;
  total_applicants: number;
  total_seats: number;
  competition_ratio: number;
  weight_distribution: {
    min: number;
    max: number;
    median: number;
    p25: number;
    p75: number;
  };
  pool_breakdown: Record<string, number>;
  commitment_hash: string;
  algorithm: string;
  seed_derivation_method: string;
  created_at: string;
}

export default function LotteryVerifyPage() {
  const t = useTranslations("lottery.verify");
  const [poolId, setPoolId] = useState("");
  const [verification, setVerification] = useState<VerificationResult | null>(
    null,
  );
  const [report, setReport] = useState<TransparencyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    if (!poolId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/lottery/pools/${poolId}/verify`);
      setVerification(res.data);
      // 투명성 리포트도 함께 로드
      const reportRes = await api.get(
        `/lottery/pools/${poolId}/transparency-report`,
      );
      setReport(reportRes.data);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      setError(detail || t("errorFallback"));
      setVerification(null);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 pt-20 pb-8">
      <h1 className="text-3xl font-bold mb-2">{t("title")}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">
        {t("description")}
      </p>

      {/* 검색 */}
      <div className="flex gap-3 mb-8">
        <input
          type="text"
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
          placeholder={t("poolIdPlaceholder")}
          className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <button
          onClick={handleVerify}
          disabled={loading || !poolId.trim()}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 font-medium"
        >
          {loading ? t("buttonLoading") : t("buttonVerify")}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
          {error}
        </div>
      )}

      {/* 검증 결과 */}
      {verification && (
        <div className="space-y-6">
          <div
            className={`p-6 rounded-lg border-2 ${verification.is_valid ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50"}`}
          >
            <div className="flex items-center gap-3 mb-2">
              <span
                className={`text-2xl ${verification.is_valid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {verification.is_valid ? "V" : "X"}
              </span>
              <h2 className="text-xl font-bold">
                {verification.is_valid
                  ? t("resultValid")
                  : t("resultInvalid")}
              </h2>
            </div>
          </div>

          {/* 기술 상세 */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-4">{t("technicalDetails")}</h3>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-gray-500">{t("algorithm")}</dt>
                <dd className="font-mono text-sm">{verification.algorithm}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">{t("seedUsed")}</dt>
                <dd className="font-mono text-sm">{verification.seed_used}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="text-sm text-gray-500">{t("commitmentHash")}</dt>
                <dd className="font-mono text-xs break-all bg-gray-50 p-2 rounded">
                  {verification.commitment_hash}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">{t("totalApplicants")}</dt>
                <dd className="font-semibold">
                  {t("countPerson", { count: verification.total_applicants ?? 0 })}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">{t("totalSeats")}</dt>
                <dd className="font-semibold">{t("countSeat", { count: verification.total_seats ?? 0 })}</dd>
              </div>
            </dl>
          </div>

          {/* 투명성 리포트 */}
          {report && (
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4">{t("transparencyReport")}</h3>
              <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <dt className="text-sm text-gray-500">{t("competitionRatio")}</dt>
                  <dd className="text-2xl font-bold">
                    {report.competition_ratio}:1
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">{t("winners")}</dt>
                  <dd className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {t("countPerson", { count: report.pool_breakdown.won ?? 0 })}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">{t("waitlisted")}</dt>
                  <dd className="text-2xl font-bold text-yellow-600">
                    {t("countPerson", { count: report.pool_breakdown.waitlisted ?? 0 })}
                  </dd>
                </div>
              </dl>

              <h4 className="text-sm font-semibold mt-6 mb-2 text-gray-700 dark:text-gray-300">
                {t("weightDistribution")}
              </h4>
              <div className="grid grid-cols-5 gap-2 text-center text-sm">
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">{t("weightMin")}</div>
                  <div className="font-semibold">
                    {report.weight_distribution.min?.toFixed(2)}
                  </div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">P25</div>
                  <div className="font-semibold">
                    {report.weight_distribution.p25?.toFixed(2)}
                  </div>
                </div>
                <div className="bg-blue-50 rounded p-2">
                  <div className="text-gray-500">{t("weightMedian")}</div>
                  <div className="font-bold">
                    {report.weight_distribution.median?.toFixed(2)}
                  </div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">P75</div>
                  <div className="font-semibold">
                    {report.weight_distribution.p75?.toFixed(2)}
                  </div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">{t("weightMax")}</div>
                  <div className="font-semibold">
                    {report.weight_distribution.max?.toFixed(2)}
                  </div>
                </div>
              </div>

              <div className="mt-4 text-sm text-gray-500">
                {t("seedDerivationMethod", { method: report.seed_derivation_method ?? "" })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

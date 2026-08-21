"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { EFFECTIVE_DATE } from "@pickket/lib";

export default function RefundPolicyPage() {
  const t = useTranslations("legal");
  return (
    <div className="bg-background min-h-screen pt-20">
      {/* Hero */}
      <section className="py-16 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-surface-dim to-background" />
        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <div className="text-center mb-12">
            <span className="inline-flex items-center px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold mb-4">
              {t("refund_badge")}
            </span>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("refund_title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("effective_date", { date: EFFECTIVE_DATE })}
            </p>
          </div>

          {/* 변경 이력 */}
          <div className="rounded-2xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-5 mb-10">
            <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300 mb-2">
              📋 주요 변경 사항 ({EFFECTIVE_DATE})
            </h3>
            <ul className="text-sm text-amber-700 dark:text-amber-400 space-y-1 list-disc list-inside">
              <li>가중 추첨 배분 결과에 대한 환불 기준 추가</li>
              <li>리세일 거래 환불 절차 및 에스크로 관련 조항 추가</li>
              <li>이벤트 취소/변경 시 자동 환불 프로세스 명시</li>
            </ul>
          </div>

          {/* 핵심 안내 배너 */}
          <div className="rounded-2xl bg-gradient-to-r from-primary/5 to-cyan/5 border-l-4 border-primary p-5 mb-10 text-sm text-foreground leading-relaxed">
            <p className="font-semibold text-foreground mb-1">환불 정책 안내</p>
            <p>
              Pickket은 「전자상거래 등에서의 소비자보호에 관한 법률」 및
              「소비자분쟁해결기준」에 따라 공정한 환불 정책을 운영합니다.
              공연·이벤트 티켓의 특수성을 고려하여 아래와 같은 기준을
              적용합니다.
            </p>
          </div>

          <div className="prose prose-gray max-w-none text-sm leading-relaxed text-foreground">
            {/* 제1조 */}
            <Section title="제1조 (청약철회 및 환불 원칙)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  「전자상거래 등에서의 소비자보호에 관한 법률」 제17조에 따라,
                  소비자는 구매일로부터 7일 이내에 청약의 철회를 할 수 있습니다.
                </li>
                <li>
                  다만, 공연·전시·스포츠 등 이벤트 티켓은 동법 제17조 제2항
                  제5호에 의거 &quot;용역의 제공이 개시된 경우&quot;에
                  해당하므로, 아래 환불 기준에 따릅니다.
                </li>
                <li>
                  환불 시 결제 수단과 동일한 방법으로 환불이 이루어지며, 동일한
                  수단으로 환불이 불가능한 경우 이를 사전에 고지합니다.
                </li>
              </ol>
            </Section>

            {/* 제2조 — 핵심 환불 기준표 */}
            <Section title="제2조 (1차 티켓 구매 환불 기준)">
              <p>
                가중 추첨 배분 또는 선착순을 통해 1차로 구매한 티켓에 대한 환불
                기준은 다음과 같습니다.
              </p>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="border border-border px-4 py-3 text-left font-semibold text-foreground">
                        취소 시점
                      </th>
                      <th className="border border-border px-4 py-3 text-left font-semibold text-foreground">
                        취소 수수료
                      </th>
                      <th className="border border-border px-4 py-3 text-left font-semibold text-foreground">
                        환불액
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-border px-4 py-3">
                        구매 후 7일 이내{" "}
                        <span className="text-cyan font-medium">
                          (공연 10일 전까지)
                        </span>
                      </td>
                      <td className="border border-border px-4 py-3 font-medium text-cyan">
                        없음 (0%)
                      </td>
                      <td className="border border-border px-4 py-3">
                        결제금액 100%
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-4 py-3">
                        공연일 10일 전 ~ 7일 전
                      </td>
                      <td className="border border-border px-4 py-3 font-medium">
                        티켓 금액의 10%
                      </td>
                      <td className="border border-border px-4 py-3">
                        결제금액의 90%
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-4 py-3">
                        공연일 7일 전 ~ 3일 전
                      </td>
                      <td className="border border-border px-4 py-3 font-medium">
                        티켓 금액의 20%
                      </td>
                      <td className="border border-border px-4 py-3">
                        결제금액의 80%
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-4 py-3">
                        공연일 3일 전 ~ 1일 전
                      </td>
                      <td className="border border-border px-4 py-3 font-medium">
                        티켓 금액의 30%
                      </td>
                      <td className="border border-border px-4 py-3">
                        결제금액의 70%
                      </td>
                    </tr>
                    <tr className="bg-red-50/50">
                      <td className="border border-border px-4 py-3">
                        공연 당일
                      </td>
                      <td className="border border-border px-4 py-3 font-medium text-red-500">
                        환불 불가
                      </td>
                      <td className="border border-border px-4 py-3 text-red-500">
                        -
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                * 상기 기준은 「소비자분쟁해결기준」(공정거래위원회 고시)의 공연
                관람 관련 기준을 준용합니다.
              </p>
              <p className="text-sm text-muted-foreground">
                * 주최자가 별도의 환불 기준을 설정한 경우, 소비자에게 유리한
                기준이 우선 적용됩니다.
              </p>
            </Section>

            {/* 제3조 */}
            <Section title="제3조 (리세일 티켓 환불 기준)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  리세일 마켓에서 구매한 티켓은 거래 완료(소유권 이전) 즉시
                  효력이 발생하며, 원칙적으로 환불이 불가합니다.
                </li>
                <li>
                  다만, 다음의 경우에는 예외적으로 환불 처리됩니다:
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>판매자의 사기 또는 허위 매물인 경우</li>
                    <li>티켓이 무효(이미 사용됨, 위조 등)로 확인된 경우</li>
                    <li>시스템 오류로 인한 이중 결제가 발생한 경우</li>
                  </ul>
                </li>
                <li>
                  리세일 거래에서 환불이 이루어지는 경우, 수수료(차익의 50%
                  주최자 귀속분 + 10% 플랫폼 수수료)는 함께 환불됩니다.
                </li>
                <li>
                  리세일 티켓의 환불이 불가한 경우, 구매자는 리세일 마켓에
                  재등록하여 재판매할 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제4조 */}
            <Section title="제4조 (공연 취소·변경 시 환불)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  <strong>주최자 사유로 공연이 취소된 경우:</strong> 티켓 구매
                  금액의 100%를 환불합니다. 취소 수수료는 부과하지 않습니다.
                </li>
                <li>
                  <strong>공연 일시·장소가 변경된 경우:</strong> 변경 사실 통지
                  후 7일 이내에 환불을 요청할 수 있으며, 이 경우 100%
                  환불됩니다.
                </li>
                <li>
                  <strong>천재지변 등 불가항력으로 공연이 취소된 경우:</strong>{" "}
                  주최자의 환불 정책에 따르며, 회사는 이를 최대한 신속하게
                  처리합니다.
                </li>
                <li>
                  공연 취소 시 리세일 티켓 구매자에게도 동일한 환불 기준이
                  적용되며, 리세일 수수료(주최자 귀속분 + 플랫폼 수수료)는 함께
                  환불됩니다.
                </li>
              </ol>
            </Section>

            {/* 제5조 */}
            <Section title="제5조 (응모 취소 및 환불)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  응모 마감 전: 자유롭게 응모를 취소할 수 있으며, 예치금이 있는
                  경우 전액 반환됩니다.
                </li>
                <li>
                  응모 마감 후 ~ 결제 전: 당첨이 확정된 경우에도 결제 기한(기본
                  24시간) 이내에 결제하지 않으면 자동 취소됩니다. 이 경우 별도의
                  취소 수수료는 없습니다.
                </li>
                <li>
                  단, 반복적인 당첨 후 결제 미이행은 서비스 이용 제한의 사유가
                  될 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제6조 */}
            <Section title="제6조 (환불 절차 및 소요 기간)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  환불 요청은 Pickket 서비스 내 &quot;마이페이지 &gt; 주문/결제
                  내역&quot;에서 신청할 수 있습니다.
                </li>
                <li>
                  고객센터(support@pickket.kr)를 통해서도 환불을 요청할 수
                  있습니다.
                </li>
                <li>
                  환불 처리 소요 기간:
                  <div className="overflow-x-auto mt-2">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="bg-muted">
                          <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                            결제 수단
                          </th>
                          <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                            환불 소요 기간
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="border border-border px-3 py-2">
                            신용카드
                          </td>
                          <td className="border border-border px-3 py-2">
                            취소 접수 후 3~5 영업일 (카드사에 따라 상이)
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-border px-3 py-2">
                            체크카드/계좌이체
                          </td>
                          <td className="border border-border px-3 py-2">
                            취소 접수 후 3~10 영업일
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-border px-3 py-2">
                            간편결제 (카카오페이, 네이버페이 등)
                          </td>
                          <td className="border border-border px-3 py-2">
                            취소 접수 후 즉시 ~ 3 영업일
                          </td>
                        </tr>
                        <tr>
                          <td className="border border-border px-3 py-2">
                            가상계좌
                          </td>
                          <td className="border border-border px-3 py-2">
                            환불 계좌 확인 후 3~5 영업일
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </li>
                <li>
                  회사는 「전자상거래 등에서의 소비자보호에 관한 법률」 제18조에
                  따라 청약철회를 접수한 날로부터 3영업일 이내에 환불 절차를
                  개시합니다.
                </li>
              </ol>
            </Section>

            {/* 제7조 */}
            <Section title="제7조 (환불이 제한되는 경우)">
              <p>다음 각 호에 해당하는 경우에는 환불이 제한될 수 있습니다.</p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>공연 당일 이후 환불을 요청한 경우</li>
                <li>이용자의 책임 있는 사유로 티켓이 훼손·분실된 경우</li>
                <li>이미 입장(사용)한 티켓의 환불 요청</li>
                <li>
                  리세일 마켓에서 구매 후 소유권이 이전된 티켓 (제3조의 예외
                  사유에 해당하지 않는 경우)
                </li>
                <li>
                  부정한 방법(매크로, 다중계정 등)으로 구매한 것이 확인된 티켓
                </li>
              </ol>
            </Section>

            {/* 제8조 */}
            <Section title="제8조 (미성년자 거래 취소)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  만 19세 미만의 미성년자가 법정대리인의 동의 없이 구매한 경우,
                  미성년자 본인 또는 법정대리인이 거래를 취소할 수 있습니다
                  (「민법」 제5조).
                </li>
                <li>
                  다만, 미성년자가 법정대리인의 동의가 있는 것으로 믿게 할 만한
                  행위를 한 경우에는 취소가 제한될 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제9조 */}
            <Section title="제9조 (분쟁 해결)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  환불 관련 분쟁이 발생한 경우, 회사와 이용자는 상호 협의하여
                  해결하기 위해 노력합니다.
                </li>
                <li>
                  분쟁이 해결되지 않는 경우, 한국소비자원(1372) 또는
                  전자거래분쟁조정위원회에 조정을 신청할 수 있습니다.
                </li>
                <li>
                  이 정책에서 정하지 아니한 사항은 「전자상거래 등에서의
                  소비자보호에 관한 법률」 및 「소비자분쟁해결기준」에 따릅니다.
                </li>
              </ol>
            </Section>

            {/* 고객센터 안내 */}
            <div className="mt-10 rounded-2xl bg-surface-dim p-6">
              <h3 className="font-bold text-foreground mb-3">환불 문의</h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>이메일: support@pickket.kr</p>
                <p>고객센터 운영시간: 평일 09:00 ~ 18:00 (공휴일 제외)</p>
                <p>
                  환불 요청 시 주문번호, 회원 정보, 환불 사유를 함께 알려주시면
                  빠르게 처리됩니다.
                </p>
              </div>
            </div>
          </div>

          {/* Related links */}
          <div className="mt-12 pt-8 border-t border-border">
            <p className="text-sm text-muted-foreground mb-3">관련 정책</p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/terms"
                className="text-sm text-primary hover:underline font-medium"
              >
                이용약관
              </Link>
              <span className="text-muted-foreground">|</span>
              <Link
                href="/privacy"
                className="text-sm text-primary hover:underline font-medium"
              >
                개인정보처리방침
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-lg font-bold text-foreground mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

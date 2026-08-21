"use client";

import { useTranslations } from "next-intl";
import { EFFECTIVE_DATE } from "@pickket/lib";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold text-foreground mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export default function YouthProtectionPage() {
  const t = useTranslations("legal");
  return (
    <div className="bg-background min-h-screen pt-20">
      {/* Hero */}
      <section className="py-16 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-surface-dim to-background" />
        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <div className="text-center mb-12">
            <span className="inline-flex items-center px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold mb-4">
              {t("legal_badge")}
            </span>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("youth_title")}
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
              <li>초판 제정 (신규 정책)</li>
            </ul>
          </div>

          <div className="prose prose-gray max-w-none text-sm leading-relaxed text-foreground">
            <Section title="제1조 (목적)">
              <p>
                주식회사 노드엑스(이하 &quot;회사&quot;)은 청소년보호법 및 관련
                법령에 따라 청소년이 유해한 환경으로부터 보호받을 수 있도록
                청소년보호정책을 수립·시행합니다.
              </p>
            </Section>

            <Section title="제2조 (연령 확인)">
              <p>
                회사는 서비스 이용 과정에서 연령 확인이 필요한 경우 다음과 같은
                조치를 취합니다.
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>회원가입 시 만 14세 이상 여부를 확인합니다.</li>
                <li>
                  만 14세 미만의 아동이 서비스를 이용하고자 하는 경우
                  법정대리인(부모 등)의 동의를 받아야 합니다.
                </li>
                <li>
                  연령에 따라 이용이 제한되는 공연·이벤트의 경우 티켓 구매 시
                  본인인증을 통해 연령을 확인할 수 있습니다.
                </li>
              </ul>
            </Section>

            <Section title="제3조 (유해 콘텐츠 제한)">
              <p>
                회사는 청소년에게 유해한 콘텐츠의 노출을 방지하기 위해 다음과
                같은 조치를 시행합니다.
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>
                  청소년 관람불가 등급의 공연·이벤트에 대해 연령 제한 표시를
                  명확히 합니다.
                </li>
                <li>
                  유해 콘텐츠가 포함된 게시물은 사전 검토 및 사후 모니터링을
                  통해 차단합니다.
                </li>
                <li>
                  이용자가 유해 콘텐츠를 신고할 수 있는 기능을 제공합니다.
                </li>
              </ul>
            </Section>

            <Section title="제4조 (보호자 동의)">
              <p>
                만 14세 미만의 아동에 대해 개인정보를 수집·이용하는 경우
                법정대리인의 동의를 받으며, 법정대리인은 아동의 개인정보 열람,
                정정·삭제, 처리정지를 요청할 수 있습니다.
              </p>
            </Section>

            <Section title="제5조 (청소년 유해매체 표시)">
              <p>
                청소년보호법에 따라 청소년 유해매체물로 지정된 공연 및 이벤트에
                대해서는 다음과 같이 표시합니다.
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>
                  &quot;19세 미만 관람불가&quot; 또는 해당 연령 제한을 티켓 상세
                  페이지에 명확히 표기합니다.
                </li>
                <li>
                  청소년의 구매가 확인된 경우 해당 주문을 취소하고 환불
                  처리합니다.
                </li>
              </ul>
            </Section>

            <Section title="제6조 (청소년보호 책임자)">
              <div className="bg-surface-dim rounded-xl p-4 space-y-1.5 not-prose text-sm">
                <p>
                  <span className="font-semibold text-foreground">
                    청소년보호 책임자:
                  </span>{" "}
                  Pickket 대표
                </p>
                <p>
                  <span className="font-semibold text-foreground">
                    청소년보호 담당부서:
                  </span>{" "}
                  고객지원팀
                </p>
                <p>
                  <span className="font-semibold text-foreground">이메일:</span>{" "}
                  support@pickket.kr
                </p>
                <p>
                  <span className="font-semibold text-foreground">문의:</span>{" "}
                  support@pickket.kr
                </p>
              </div>
            </Section>

            <Section title="제7조 (신고 및 상담)">
              <p>
                청소년 유해 콘텐츠 또는 청소년 보호 관련 문의는 아래로
                연락해주시기 바랍니다.
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Pickket 고객센터: support@pickket.kr</li>
                <li>방송통신심의위원회: https://www.kocsc.or.kr</li>
                <li>여성가족부 청소년 상담전화: 1388</li>
              </ul>
            </Section>

            <Section title="부칙">
              <p>본 정책은 {EFFECTIVE_DATE}부터 시행합니다.</p>
            </Section>
          </div>
        </div>
      </section>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { EFFECTIVE_DATE } from "@pickket/lib";

export default function TermsPage() {
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
              {t("terms_title")}
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
              <li>제17조 (추첨 공정성) 신설 — 커밋-리빌 추첨 검증 조항 추가</li>
              <li>
                제18조 (단골 우대석) 신설 — 최대 10% 단골 우선 배정 조건 명시
              </li>
              <li>
                제19조 (신규 가입자 혜택) 신설 — Pool B 15% 배정 및 Newcomer
                Shield
              </li>
              <li>제20조 (AP 포인트) 신설 — AP 적립/소멸/양도불가 규정</li>
            </ul>
          </div>

          <div className="prose prose-gray max-w-none text-sm leading-relaxed text-foreground">
            {/* 제1조 */}
            <Section title="제1조 (목적)">
              <p>
                이 약관은 주식회사 노드엑스(이하 &quot;회사&quot;)이 운영하는
                티켓 배분 및 리세일 플랫폼 서비스(이하 &quot;서비스&quot;)의
                이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항, 기타
                필요한 사항을 규정함을 목적으로 합니다.
              </p>
            </Section>

            {/* 제2조 */}
            <Section title="제2조 (정의)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  &quot;서비스&quot;란 회사가 제공하는 티켓 응모, 배분, 구매,
                  리세일 및 이에 부수하는 일체의 서비스를 말합니다.
                </li>
                <li>
                  &quot;이용자&quot;란 이 약관에 따라 회사가 제공하는 서비스를
                  이용하는 회원 및 비회원을 말합니다.
                </li>
                <li>
                  &quot;회원&quot;이란 회사에 개인정보를 제공하여 회원등록을 한
                  자로서 회사가 제공하는 서비스를 이용할 수 있는 자를 말합니다.
                </li>
                <li>
                  &quot;응모&quot;란 회원이 티켓 구매를 위해 희망 가격 및 수량을
                  제출하는 행위를 말합니다.
                </li>
                <li>
                  &quot;공정 배분&quot;이란 AP 가중 공정 추첨에 기반한 공정 배분
                  방식을 말합니다.
                </li>
                <li>
                  &quot;리세일&quot;이란 1차 배분을 통해 획득한 티켓을 플랫폼
                  내에서 재판매하는 행위를 말합니다.
                </li>
                <li>
                  &quot;주최자&quot;란 공연, 전시, 스포츠 등 이벤트를 기획하고
                  회사를 통해 티켓을 판매하는 자를 말합니다.
                </li>
              </ol>
            </Section>

            {/* 제3조 */}
            <Section title="제3조 (약관의 효력 및 변경)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  이 약관은 서비스 화면에 게시하거나 기타의 방법으로 이용자에게
                  공지함으로써 효력이 발생합니다.
                </li>
                <li>
                  회사는 「약관의 규제에 관한 법률」, 「전자상거래 등에서의
                  소비자보호에 관한 법률」, 「정보통신망 이용촉진 및 정보보호
                  등에 관한 법률」 등 관련 법령을 위배하지 않는 범위에서 이
                  약관을 변경할 수 있습니다.
                </li>
                <li>
                  회사가 약관을 변경할 경우, 적용일자 및 변경사유를 명시하여
                  현행 약관과 함께 서비스 초기 화면에 그 적용일자 7일 전부터
                  적용일자 전일까지 공지합니다. 다만, 이용자에게 불리한 약관
                  변경의 경우에는 30일 전부터 공지합니다.
                </li>
                <li>
                  회원이 변경된 약관의 적용에 동의하지 않는 경우, 이용계약을
                  해지할 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제4조 */}
            <Section title="제4조 (서비스의 제공)">
              <p>회사는 다음 각 호의 서비스를 제공합니다.</p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>공연, 전시, 스포츠 등 이벤트 티켓의 응모 및 배분 서비스</li>
                <li>AI 기반 공정 배분 서비스</li>
                <li>티켓 리세일(2차 거래) 중개 서비스</li>
                <li>리세일 수익 배분(판매자, 주최자 귀속) 서비스</li>
                <li>이벤트 정보 제공 및 추천 서비스</li>
                <li>기타 회사가 정하는 부가 서비스</li>
              </ol>
            </Section>

            {/* 제5조 */}
            <Section title="제5조 (이용계약의 체결)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  이용계약은 회원이 되고자 하는 자(이하
                  &quot;가입신청자&quot;)가 약관의 내용에 대하여 동의를 한 다음
                  회원가입 신청을 하고, 회사가 이를 승낙함으로써 체결됩니다.
                </li>
                <li>
                  회사는 가입신청자의 신청에 대하여 원칙적으로 승낙합니다. 다만,
                  다음 각 호에 해당하는 경우 승낙을 거부하거나 유보할 수
                  있습니다.
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>실명이 아니거나 타인의 명의를 이용한 경우</li>
                    <li>
                      허위 정보를 기재하거나 필수 사항을 기재하지 않은 경우
                    </li>
                    <li>
                      만 14세 미만인 경우 (법정대리인의 동의 없이 가입한 경우)
                    </li>
                    <li>
                      이전에 이용약관을 위반하여 이용계약이 해지된 이력이 있는
                      경우
                    </li>
                  </ul>
                </li>
                <li>
                  회원은 본인인증 절차를 완료하여야 응모, 구매, 리세일 서비스를
                  이용할 수 있습니다. 이는 「공연법」 및 암표방지 관련 법령(이하
                  &quot;암표3법&quot;)에 따른 본인인증 의무를 이행하기
                  위함입니다.
                </li>
              </ol>
            </Section>

            {/* 제6조 */}
            <Section title="제6조 (회원정보의 변경)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회원은 개인정보 관리화면을 통하여 언제든지 본인의 개인정보를
                  열람하고 수정할 수 있습니다.
                </li>
                <li>
                  회원은 회원가입 시 기재한 사항이 변경되었을 경우, 온라인으로
                  수정하거나 고객센터를 통하여 회사에 변경사항을 알려야 합니다.
                </li>
                <li>
                  변경사항을 알리지 않아 발생한 불이익에 대하여 회사는 책임지지
                  않습니다.
                </li>
              </ol>
            </Section>

            {/* 제7조 */}
            <Section title="제7조 (회원의 의무)">
              <p>회원은 다음 각 호의 행위를 하여서는 안 됩니다.</p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>신청 또는 변경 시 허위 내용의 등록</li>
                <li>타인의 정보 도용</li>
                <li>서비스에 게시된 정보의 변경</li>
                <li>
                  회사가 정한 정보 이외의 정보(컴퓨터 프로그램 등)의 송신 또는
                  게시
                </li>
                <li>회사 및 기타 제3자의 지식재산권 등 권리 침해</li>
                <li>
                  회사 및 기타 제3자의 명예를 손상시키거나 업무를 방해하는 행위
                </li>
                <li>
                  매크로, 봇 등 자동화 프로그램을 이용한 응모 및 구매 행위
                </li>
                <li>
                  부정한 방법으로 다수의 계정을 생성하여 응모에 참여하는 행위
                </li>
                <li>
                  플랫폼 외부에서의 티켓 재판매(암표 행위). 이는 「공연법」
                  제2조의2 및 암표3법에 따라 법적 처벌 대상이 될 수 있습니다.
                </li>
                <li>
                  주최자가 설정한 리세일 조건을 회피하기 위한 일체의 부정행위
                </li>
                <li>기타 불법적이거나 부당한 행위</li>
              </ol>
            </Section>

            {/* 제8조 */}
            <Section title="제8조 (서비스 이용 제한 및 계약 해지)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사는 회원이 제7조의 의무를 위반하거나 서비스의 정상적인
                  운영을 방해한 경우, 경고, 일시정지, 영구정지 등으로 서비스
                  이용을 단계적으로 제한할 수 있습니다.
                </li>
                <li>
                  회사는 전항에도 불구하고, 매크로/봇 사용, 명의도용, 외부 암표
                  행위 등 중대한 위반이 확인된 경우 즉시 이용계약을 해지할 수
                  있습니다.
                </li>
                <li>
                  회원은 언제든지 고객센터를 통하여 이용계약 해지를 신청할 수
                  있으며, 회사는 관련 법령이 정하는 바에 따라 이를 즉시
                  처리합니다.
                </li>
                <li>
                  이용계약이 해지된 경우, 회원의 개인정보는 「개인정보 보호법」
                  및 회사의 개인정보처리방침에 따라 처리됩니다.
                </li>
              </ol>
            </Section>

            {/* 제9조 */}
            <Section title="제9조 (티켓 응모 및 배분)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회원은 이벤트 응모 기간 내에 AP(활동 포인트)를 투입하여 응모에
                  참여할 수 있습니다.
                </li>
                <li>
                  응모 마감 후, 회사의 공정 배분 시스템에 의해 당첨자가
                  결정됩니다. 당첨 시 정가 결제가 보장되며, 정가보다 높게
                  결제되지 않습니다.
                </li>
                <li>
                  당첨 결과는 확정 즉시 회원에게 통지되며, 회원은 정해진 기한
                  내에 결제를 완료하여야 합니다.
                </li>
                <li>
                  결제 기한(기본 24시간) 내에 결제하지 않은 경우, 당첨은 자동
                  취소됩니다.
                </li>
                <li>응모 취소는 응모 마감 시간 전까지 가능합니다.</li>
              </ol>
            </Section>

            {/* 제10조 */}
            <Section title="제10조 (리세일 서비스)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회원은 1차 배분을 통해 정당하게 취득한 티켓에 한하여 회사의
                  리세일 마켓에서 재판매할 수 있습니다.
                </li>
                <li>
                  리세일 가격은 주최자가 설정한 조건에 따라 제한됩니다. 이는
                  「공연법」 및 암표3법의 과도한 가격 인상 방지 취지를 준수하기
                  위함입니다.
                </li>
                <li>
                  리세일 거래 시 수익은 다음과 같이 배분됩니다:
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>
                      판매자: 원가(정가 또는 1차 구매가) 전액 + 리세일 차익의
                      40%
                    </li>
                    <li>
                      플랫폼 수수료: 리세일 차익(판매가 − 원가)의 10% (정가 양도
                      시 0원)
                    </li>
                    <li>
                      주최자 귀속: 리세일 차익의 50% (아티스트·제작사에게 자동
                      배분, 정가 양도 시 0원)
                    </li>
                  </ul>
                </li>
                <li>
                  회사는 리세일 거래의 중개자로서 에스크로 방식으로 결제를
                  처리하며, 거래 완료 후 수익을 배분합니다.
                </li>
                <li>
                  리세일 등록 후 구매자가 확정되기 전까지 판매자는 등록을 취소할
                  수 있습니다.
                </li>
                <li>
                  회사 외부에서의 티켓 재판매는 본 약관 및 관련 법령에 의해
                  금지됩니다.
                </li>
              </ol>
            </Section>

            {/* 제11조 */}
            <Section title="제11조 (결제 및 환불)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회원은 회사가 제공하는 결제 수단을 통하여 티켓 대금을
                  결제합니다.
                </li>
                <li>
                  환불에 관한 사항은 「전자상거래 등에서의 소비자보호에 관한
                  법률」 및 회사의{" "}
                  <Link
                    href="/refund-policy"
                    className="text-primary hover:underline font-medium"
                  >
                    환불 정책
                  </Link>
                  에 따릅니다.
                </li>
                <li>
                  청약철회 및 환불에 관한 상세한 내용은 환불 정책 페이지를
                  참조하시기 바랍니다.
                </li>
              </ol>
            </Section>

            {/* 제12조 */}
            <Section title="제12조 (개인정보보호)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사는 「개인정보 보호법」, 「정보통신망 이용촉진 및 정보보호
                  등에 관한 법률」 등 관련 법령이 정하는 바에 따라 회원의
                  개인정보를 보호합니다.
                </li>
                <li>
                  개인정보의 수집, 이용, 제공, 보관, 파기 등에 관한 상세한
                  내용은 회사의{" "}
                  <Link
                    href="/privacy"
                    className="text-primary hover:underline font-medium"
                  >
                    개인정보처리방침
                  </Link>
                  에 따릅니다.
                </li>
              </ol>
            </Section>

            {/* 제13조 */}
            <Section title="제13조 (지식재산권)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  서비스 내 회사가 작성한 저작물에 대한 지식재산권은 회사에
                  귀속됩니다.
                </li>
                <li>
                  이용자는 서비스를 이용함으로써 얻은 정보를 회사의 사전 승낙
                  없이 복제, 송신, 출판, 배포, 방송 기타 방법에 의하여 영리
                  목적으로 이용하거나 제3자에게 이용하게 하여서는 안 됩니다.
                </li>
              </ol>
            </Section>

            {/* 제14조 */}
            <Section title="제14조 (손해배상)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사 또는 회원이 이 약관의 규정을 위반하여 상대방에게 손해가
                  발생한 경우, 귀책사유 있는 당사자는 상대방에게 발생한 손해를
                  배상할 책임이 있습니다.
                </li>
                <li>
                  회사는 무료로 제공되는 서비스 이용과 관련하여 회원에게 발생한
                  손해에 대해서는 책임을 지지 않습니다. 다만, 회사의 고의 또는
                  중과실에 의한 경우는 그러하지 아니합니다.
                </li>
              </ol>
            </Section>

            {/* 제15조 */}
            <Section title="제15조 (면책조항)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사는 천재지변 또는 이에 준하는 불가항력으로 인하여 서비스를
                  제공할 수 없는 경우에는 서비스 제공에 관한 책임이 면제됩니다.
                </li>
                <li>
                  회사는 이벤트 주최자의 사정으로 인한 공연 취소, 변경 등에
                  대해서는 직접적인 책임을 지지 않으며, 이 경우 주최자의 환불
                  정책에 따릅니다.
                </li>
                <li>
                  회사는 회원의 귀책사유로 인한 서비스 이용의 장애에 대하여
                  책임을 지지 않습니다.
                </li>
              </ol>
            </Section>

            {/* 제16조 */}
            <Section title="제16조 (분쟁해결 및 관할법원)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사와 회원 간에 발생한 전자상거래 분쟁에 관한 소송은
                  「민사소송법」에 의한 관할법원에 제기합니다.
                </li>
                <li>
                  회사와 회원 간에 발생한 분쟁에 관하여는 한국소비자원,
                  전자거래분쟁조정위원회 등 관련 기관에 분쟁조정을 신청할 수
                  있습니다.
                </li>
                <li>
                  이 약관에서 정하지 아니한 사항과 약관의 해석에 관하여는
                  「전자상거래 등에서의 소비자보호에 관한 법률」, 「약관의
                  규제에 관한 법률」, 공정거래위원회가 정하는 「전자상거래
                  등에서의 소비자보호지침」 및 관계 법령에 따릅니다.
                </li>
              </ol>
            </Section>

            {/* 제17조 */}
            <Section title="제17조 (추첨 공정성)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  본 플랫폼은 모든 추첨에 암호학적 커밋-리빌(Commit-Reveal)
                  방식을 적용하여 추첨 결과의 사전 조작을 방지합니다.
                </li>
                <li>
                  추첨 시 서버 시드와 참가자 시드를 결합하여 최종 추첨 시드를
                  생성하며, 추첨 완료 후 검증 API를 통해 누구나 결과를
                  독립적으로 재현·검증할 수 있습니다.
                </li>
                <li>
                  주최자는 12종의 사전 정의된 이벤트 템플릿 중 하나를 선택할 수
                  있으며, 템플릿 변경 시 플랫폼 관리자의 사전 승인이 필요합니다.
                </li>
              </ol>
            </Section>

            {/* 제18조 */}
            <Section title="제18조 (단골 우대석)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  주최자는 전체 좌석의 최대 10%를 단골 관객에게 우선 배정할 수
                  있습니다.
                </li>
                <li>
                  주최자의 관계사(임직원, 하도급업체 등) 소속 직원은 단골 우대
                  대상에서 제외됩니다.
                </li>
                <li>
                  단골 우대석 운영 여부는 이벤트 상세 페이지에 명시됩니다.
                </li>
              </ol>
            </Section>

            {/* 제19조 */}
            <Section title="제19조 (신규 가입자 혜택)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  가입 6개월 이내의 신규 사용자에게는 전체 좌석의 15%가 전용
                  추첨 풀(Pool B)로 배정됩니다.
                </li>
                <li>
                  가입 30일 이내이며 프로필을 완성한 사용자에게는 첫 3회 응모에
                  한해 1.5배 가중치 부스트(Newcomer Shield)가 적용됩니다.
                </li>
              </ol>
            </Section>

            {/* 제20조 */}
            <Section title="제20조 (AP 포인트)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  AP(Action Point)는 현금 가치가 없는 리워드 포인트이며, 현금
                  환급이 불가합니다.
                </li>
                <li>
                  AP는 순수 활동 기반으로만 적립되며, 어떠한 경우에도 현금→AP
                  전환은 불가합니다.
                </li>
                <li>AP는 계정 간 양도가 불가하며, 본인 인증이 필수입니다.</li>
                <li>
                  마지막 활동으로부터 12개월 비활동 시 잔여 AP가 소멸됩니다.
                  소멸 30일 전 및 7일 전에 알림을 발송합니다.
                </li>
                <li>
                  AP 정책 변경 시 30일 전에 복수 채널(이메일, 앱 푸시)을 통해
                  사전 고지합니다.
                </li>
              </ol>
            </Section>

            {/* 부칙 */}
            <Section title="부칙">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>이 약관은 {EFFECTIVE_DATE}부터 시행합니다.</li>
              </ol>
            </Section>
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

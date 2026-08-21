"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { EFFECTIVE_DATE } from "@pickket/lib";

export default function PrivacyPage() {
  const t = useTranslations("legal");
  return (
    <div className="bg-background min-h-screen pt-20">
      {/* Hero */}
      <section className="py-16 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-surface-dim to-background" />
        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <div className="text-center mb-12">
            <span className="inline-flex items-center px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold mb-4">
              {t("privacy_badge")}
            </span>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("privacy_title")}
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
              <li>가중 추첨 배분을 위한 응모 데이터 처리 근거 추가</li>
              <li>팬 가중치 산정을 위한 활동 데이터 수집 항목 명시</li>
              <li>리세일 거래 기록 보관 기간(5년) 명시</li>
              <li>GDPR/개인정보 이동권 행사 절차 구체화</li>
            </ul>
          </div>

          <div className="rounded-2xl bg-surface-dim p-5 mb-10 text-sm text-muted-foreground leading-relaxed">
            주식회사 노드엑스(이하 &quot;회사&quot;)은 「개인정보 보호법」
            제30조에 따라 정보주체의 개인정보를 보호하고 이와 관련한 고충을
            신속하고 원활하게 처리할 수 있도록 하기 위하여 다음과 같이 개인정보
            처리방침을 수립·공개합니다.
          </div>

          <div className="prose prose-gray max-w-none text-sm leading-relaxed text-foreground">
            {/* 제1조 */}
            <Section title="제1조 (개인정보의 처리 목적)">
              <p>
                회사는 다음의 목적을 위하여 개인정보를 처리합니다. 처리하고 있는
                개인정보는 다음의 목적 이외의 용도로는 이용되지 않으며, 이용
                목적이 변경되는 경우에는 「개인정보 보호법」 제18조에 따라
                별도의 동의를 받는 등 필요한 조치를 이행합니다.
              </p>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        처리 목적
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        상세
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        회원 가입 및 관리
                      </td>
                      <td className="border border-border px-3 py-2">
                        회원제 서비스 이용에 따른 본인 확인, 회원자격 유지·관리,
                        서비스 부정이용 방지, 각종 고지·통지, 고충처리
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        서비스 제공
                      </td>
                      <td className="border border-border px-3 py-2">
                        티켓 응모·배분·구매·리세일 서비스 제공, 본인인증, 결제
                        및 정산, 콘텐츠 제공, 맞춤형 서비스 제공
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        민원 사무 처리
                      </td>
                      <td className="border border-border px-3 py-2">
                        민원인의 신원 확인, 민원사항 확인, 사실 조사를 위한
                        연락·통지, 처리 결과 통보
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        법적 의무 이행
                      </td>
                      <td className="border border-border px-3 py-2">
                        「공연법」 및 암표3법에 따른 본인인증 의무 이행,
                        「전자상거래법」에 따른 거래기록 보존
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        마케팅 및 광고
                      </td>
                      <td className="border border-border px-3 py-2">
                        이벤트 정보 및 참여 기회 제공, 서비스 이용 통계 (별도
                        동의 시에만 처리)
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Section>

            {/* 제2조 */}
            <Section title="제2조 (처리하는 개인정보의 항목)">
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        구분
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        수집 항목
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        수집 방법
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        필수
                      </td>
                      <td className="border border-border px-3 py-2">
                        이름, 이메일 주소, 비밀번호(암호화), 휴대전화번호
                      </td>
                      <td className="border border-border px-3 py-2">
                        회원가입
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        본인인증
                      </td>
                      <td className="border border-border px-3 py-2">
                        CI/DI, 생년월일, 성별, 내/외국인 구분
                      </td>
                      <td className="border border-border px-3 py-2">
                        본인인증 시
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        결제
                      </td>
                      <td className="border border-border px-3 py-2">
                        결제 수단 정보(카드번호 일부, 은행계좌 일부), 결제 이력
                      </td>
                      <td className="border border-border px-3 py-2">
                        결제 시
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        자동 수집
                      </td>
                      <td className="border border-border px-3 py-2">
                        IP 주소, 쿠키, 서비스 이용 기록, 접속 로그, 기기 정보
                      </td>
                      <td className="border border-border px-3 py-2">
                        서비스 이용 시
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2 align-top font-medium">
                        선택
                      </td>
                      <td className="border border-border px-3 py-2">
                        프로필 사진, 선호 장르/아티스트, 거주 지역
                      </td>
                      <td className="border border-border px-3 py-2">
                        서비스 이용 중
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Section>

            {/* 제3조 */}
            <Section title="제3조 (개인정보의 처리 및 보유 기간)">
              <p>
                회사는 법령에 따른 개인정보 보유·이용 기간 또는 정보주체로부터
                동의 받은 기간 내에서 개인정보를 처리·보유합니다.
              </p>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        보존 항목
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        보존 기간
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        근거 법령
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        계약 또는 청약철회 등에 관한 기록
                      </td>
                      <td className="border border-border px-3 py-2 font-medium">
                        5년
                      </td>
                      <td className="border border-border px-3 py-2">
                        전자상거래법
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        대금결제 및 재화 등의 공급에 관한 기록
                      </td>
                      <td className="border border-border px-3 py-2 font-medium">
                        5년
                      </td>
                      <td className="border border-border px-3 py-2">
                        전자상거래법
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        소비자의 불만 또는 분쟁처리에 관한 기록
                      </td>
                      <td className="border border-border px-3 py-2 font-medium">
                        3년
                      </td>
                      <td className="border border-border px-3 py-2">
                        전자상거래법
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        본인인증에 관한 기록
                      </td>
                      <td className="border border-border px-3 py-2 font-medium">
                        6개월
                      </td>
                      <td className="border border-border px-3 py-2">
                        정보통신망법
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        접속에 관한 기록(로그)
                      </td>
                      <td className="border border-border px-3 py-2 font-medium">
                        3개월
                      </td>
                      <td className="border border-border px-3 py-2">
                        통신비밀보호법
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                상기 법정 보유기간 경과 후 또는 처리 목적 달성 후에는 해당
                개인정보를 지체 없이 파기합니다.
              </p>
            </Section>

            {/* 제4조 */}
            <Section title="제4조 (개인정보의 제3자 제공)">
              <p>
                회사는 원칙적으로 정보주체의 개인정보를 제3자에게 제공하지
                않습니다. 다만, 다음의 경우에는 예외로 합니다.
              </p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>정보주체가 사전에 동의한 경우</li>
                <li>
                  법령의 규정에 의하거나, 수사 목적으로 법령에 정해진 절차와
                  방법에 따라 수사기관의 요구가 있는 경우
                </li>
                <li>
                  이벤트 주최자에게 입장·본인확인 목적으로 티켓 구매자의 성명 및
                  본인인증 결과를 제공하는 경우 (최소한의 정보에 한함)
                </li>
                <li>
                  리세일 거래 시 구매자·판매자 간 거래 이행을 위해 필요한
                  최소한의 정보를 제공하는 경우
                </li>
              </ol>
            </Section>

            {/* 제5조 */}
            <Section title="제5조 (개인정보처리의 위탁)">
              <p>
                회사는 원활한 서비스 제공을 위해 다음과 같이 개인정보 처리업무를
                위탁하고 있습니다.
              </p>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        위탁받는 자 (수탁자)
                      </th>
                      <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                        위탁하는 업무의 내용
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        PG사 (결제대행 업체)
                      </td>
                      <td className="border border-border px-3 py-2">
                        전자결제 처리, 결제 정보 관리
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        본인인증 대행 업체
                      </td>
                      <td className="border border-border px-3 py-2">
                        휴대전화 본인인증 서비스 제공
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        클라우드 서비스 제공업체
                      </td>
                      <td className="border border-border px-3 py-2">
                        데이터 보관 및 서버 운영
                      </td>
                    </tr>
                    <tr>
                      <td className="border border-border px-3 py-2">
                        이메일/SMS 발송 대행 업체
                      </td>
                      <td className="border border-border px-3 py-2">
                        알림 및 마케팅 메시지 발송
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                위탁계약 시 개인정보가 안전하게 관리될 수 있도록 필요한 사항을
                규정하고 있으며, 위탁받는 자가 개인정보를 안전하게 처리하는지를
                감독합니다.
              </p>
            </Section>

            {/* 제6조 */}
            <Section title="제6조 (개인정보의 파기)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사는 개인정보 보유기간의 경과, 처리목적 달성 등 개인정보가
                  불필요하게 되었을 때에는 지체 없이 해당 개인정보를 파기합니다.
                </li>
                <li>
                  파기 방법:
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>
                      전자적 파일 형태: 복구 및 재생이 불가능한 방법으로 영구
                      삭제
                    </li>
                    <li>종이 문서: 분쇄기로 분쇄하거나 소각</li>
                  </ul>
                </li>
                <li>
                  법령에 따라 보존이 필요한 개인정보는 해당 기간 동안 별도
                  분리하여 안전하게 보관합니다.
                </li>
              </ol>
            </Section>

            {/* 제7조 */}
            <Section title="제7조 (정보주체의 권리·의무 및 행사방법)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  정보주체는 회사에 대해 언제든지 다음 각 호의 개인정보 보호
                  관련 권리를 행사할 수 있습니다.
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>개인정보 열람 요구</li>
                    <li>오류 등이 있을 경우 정정 요구</li>
                    <li>삭제 요구</li>
                    <li>처리정지 요구</li>
                  </ul>
                </li>
                <li>
                  권리 행사는 서비스 내 설정, 이메일(support@pickket.kr), 또는
                  고객센터를 통하여 하실 수 있으며, 회사는 이에 대해 지체 없이
                  조치하겠습니다.
                </li>
                <li>
                  정보주체가 개인정보의 오류 등에 대한 정정 또는 삭제를 요구한
                  경우에는 회사는 정정 또는 삭제를 완료할 때까지 당해 개인정보를
                  이용하거나 제공하지 않습니다.
                </li>
                <li>
                  만 14세 미만 아동의 법정대리인은 해당 아동의 개인정보에 대한
                  열람, 정정·삭제, 처리정지를 요구할 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제8조 */}
            <Section title="제8조 (개인정보의 안전성 확보조치)">
              <p>
                회사는 개인정보의 안전성 확보를 위해 다음과 같은 조치를 취하고
                있습니다.
              </p>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  <strong>관리적 조치:</strong> 내부관리계획 수립·시행, 개인정보
                  취급 직원 지정 및 최소화, 정기적 자체 감사 실시
                </li>
                <li>
                  <strong>기술적 조치:</strong> 개인정보처리시스템 접근 권한
                  관리, 접근통제시스템 설치, 고유식별정보 및 비밀번호의
                  암호화(bcrypt), 보안프로그램 설치, 접속기록의 보관 및 위변조
                  방지
                </li>
                <li>
                  <strong>물리적 조치:</strong> 전산실, 자료보관실 등의 접근통제
                </li>
              </ol>
            </Section>

            {/* 제9조 */}
            <Section title="제9조 (개인정보 자동 수집 장치의 설치·운영 및 거부에 관한 사항)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  회사는 이용자에게 개별적인 맞춤서비스를 제공하기 위해
                  이용정보를 저장하고 수시로 불러오는 &apos;쿠키(cookie)&apos;를
                  사용합니다.
                </li>
                <li>
                  쿠키의 사용 목적:
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    <li>
                      이용자의 접속 빈도나 방문 시간 등을 분석하여 서비스 개선
                    </li>
                    <li>이용자의 관심 분야에 따른 맞춤형 콘텐츠 제공</li>
                    <li>로그인 유지 및 보안 강화</li>
                  </ul>
                </li>
                <li>
                  이용자는 쿠키 설치에 대한 선택권을 가지고 있습니다. 웹
                  브라우저 옵션 설정을 통해 모든 쿠키를 허용하거나, 쿠키가
                  저장될 때마다 확인을 거치거나, 모든 쿠키의 저장을 거부할 수
                  있습니다.
                </li>
                <li>
                  다만, 쿠키 설치를 거부할 경우 로그인이 필요한 일부 서비스
                  이용에 어려움이 있을 수 있습니다.
                </li>
              </ol>
            </Section>

            {/* 제10조 */}
            <Section title="제10조 (개인정보 보호책임자)">
              <p>
                회사는 개인정보 처리에 관한 업무를 총괄해서 책임지고, 정보주체의
                불만처리 및 피해구제를 위하여 아래와 같이 개인정보 보호책임자를
                지정하고 있습니다.
              </p>
              <div className="mt-3 rounded-xl bg-surface-dim p-5 text-sm">
                <p className="font-semibold text-foreground mb-2">
                  개인정보 보호책임자
                </p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>직책: 개인정보보호 담당</li>
                  <li>연락처: support@pickket.kr</li>
                  <li>고객센터: support@pickket.kr</li>
                </ul>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                정보주체는 서비스를 이용하면서 발생한 모든 개인정보 보호 관련
                문의, 불만처리, 피해구제 등에 관한 사항을 개인정보
                보호책임자에게 문의하실 수 있습니다.
              </p>
            </Section>

            {/* 제11조 */}
            <Section title="제11조 (권익침해 구제방법)">
              <p>
                정보주체는 개인정보침해로 인한 구제를 받기 위하여 다음 기관에
                분쟁해결이나 상담 등을 신청할 수 있습니다.
              </p>
              <div className="mt-3 rounded-xl bg-surface-dim p-5 text-sm space-y-3">
                <div>
                  <p className="font-semibold text-foreground">
                    개인정보 침해신고센터 (한국인터넷진흥원)
                  </p>
                  <p className="text-muted-foreground">
                    전화: (국번없이) 118 | 홈페이지: privacy.kisa.or.kr
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-foreground">
                    개인정보 분쟁조정위원회
                  </p>
                  <p className="text-muted-foreground">
                    전화: (국번없이) 1833-6972 | 홈페이지: www.kopico.go.kr
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-foreground">
                    대검찰청 사이버수사과
                  </p>
                  <p className="text-muted-foreground">
                    전화: (국번없이) 1301 | 홈페이지: www.spo.go.kr
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-foreground">
                    경찰청 사이버수사국
                  </p>
                  <p className="text-muted-foreground">
                    전화: (국번없이) 182 | 홈페이지: ecrm.cyber.go.kr
                  </p>
                </div>
              </div>
            </Section>

            {/* 제12조 */}
            <Section title="제12조 (개인정보 처리방침의 변경)">
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>이 개인정보 처리방침은 {EFFECTIVE_DATE}부터 적용됩니다.</li>
                <li>
                  이전의 개인정보 처리방침은 아래에서 확인하실 수 있습니다.
                  <ul className="list-disc pl-5 mt-1">
                    <li>해당 없음 (최초 시행)</li>
                  </ul>
                </li>
              </ol>
            </Section>
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
                href="/refund-policy"
                className="text-sm text-primary hover:underline font-medium"
              >
                환불 정책
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

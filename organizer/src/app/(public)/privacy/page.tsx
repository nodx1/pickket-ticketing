// 루트 layout 의 `title.template`("%s — PICKKET.GO")이 브랜드명을 붙인다.
// 🔴 여기에 브랜드명을 다시 쓰면 "… — PICKKET.GO — PICKKET.GO" 가 된다.
export const metadata = { title: "개인정보처리방침" };

const sections = [
  ["수집 항목", "이름, 이메일, 전화번호, 결제 관련 정보, 서비스 이용 기록을 수집할 수 있습니다."],
  ["수집 목적", "서비스 제공, 본인 확인, 결제 처리, 고객 지원, 알림 발송 및 법령상 보관 의무 이행을 위해 수집합니다."],
  ["보유 기간", "전자상거래법 등 관계 법령에 따라 서비스 이용 종료 후 최대 5년간 보관할 수 있습니다."],
  ["제3자 제공", "결제 처리 및 정산을 위해 PG사(토스, 카카오, 네이버) 등에게 필요한 범위 내에서 제공될 수 있습니다."],
  ["안전성 확보", "접근 통제, 암호화, 로그 관리 등 기술적·관리적 보호조치를 시행합니다."],
  ["이용자 권리", "이용자는 개인정보 열람, 정정, 삭제, 처리정지를 요청할 수 있습니다."],
  ["개인정보보호 책임자", "이메일 support@pickket.kr, 운영팀이 개인정보보호 책임 업무를 수행합니다."],
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <div className="rounded-xl border border-border bg-card/95 p-8">
        <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">개인정보처리방침</h1>
        <div className="mt-8 space-y-6">
          {sections.map(([title, body]) => (
            <section key={title}>
              <h2 className="text-lg font-bold text-foreground">{title}</h2>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">{body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

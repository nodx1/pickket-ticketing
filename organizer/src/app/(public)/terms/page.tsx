// 루트 layout 의 `title.template`("%s — PICKKET.GO")이 브랜드명을 붙인다.
// 🔴 여기에 브랜드명을 다시 쓰면 "… — PICKKET.GO — PICKKET.GO" 가 된다.
export const metadata = { title: "이용약관" };

const sections = [
  ["제1조 목적", "이 약관은 PICKKET.GO가 제공하는 이벤트 티켓팅 및 운영 서비스의 이용 조건과 절차를 규정합니다."],
  ["제2조 정의", "회원, 주최자, 구매자, 티켓, 주문의 의미는 서비스 화면과 본 약관에서 정한 바를 따릅니다."],
  ["제3조 약관 효력", "회사는 약관을 서비스 화면에 게시함으로써 효력이 발생하며, 관계 법령에 따라 개정할 수 있습니다."],
  ["제4조 서비스 이용", "회원은 계정 생성 후 이벤트 개설, 티켓 판매, 참석자 관리 기능을 이용할 수 있습니다."],
  ["제5조 이용자의 의무", "이용자는 관계 법령, 본 약관 및 서비스 운영정책을 준수해야 하며 타인의 권리를 침해해서는 안 됩니다."],
  ["제6조 개인정보보호", "회사는 개인정보보호법 등 관련 법령에 따라 개인정보를 보호하며, 자세한 내용은 개인정보처리방침을 따릅니다."],
  ["제7조 환불정책", "환불은 이벤트별 고지 정책과 관련 법령을 따르며, 별도 페이지의 환불정책을 참고합니다."],
  ["제8조 면책조항", "회사는 천재지변, 통신 장애, 주최자 귀책으로 발생한 손해에 대해 법령상 허용 범위에서 책임을 제한할 수 있습니다."],
  ["제9조 분쟁해결", "분쟁은 당사자 간 협의를 우선하며, 협의가 되지 않을 경우 관련 법령상 관할 법원에 제소할 수 있습니다."],
  ["제10조 준거법", "본 약관은 대한민국 법률을 준거법으로 합니다."],
];

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <div className="rounded-xl border border-border bg-card/95 p-8">
        <h1 className="text-3xl font-black tracking-[-0.04em] text-foreground">이용약관</h1>
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

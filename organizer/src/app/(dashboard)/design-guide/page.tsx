import { Metadata } from "next";

export const metadata: Metadata = {
  title: "디자인 가이드 | PICKKET",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-6 border-b border-border pb-3 text-2xl font-black tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function SpecTable({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border last:border-0">
              <td className="bg-muted/50 px-4 py-2.5 font-medium text-foreground">{row.label}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SafeAreaDiagram({ ratio, label, safePercent }: { ratio: string; label: string; safePercent: number }) {
  const dangerHeight = `${(100 - safePercent) / 2}%`;
  const safeHeight = `${safePercent}%`;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className={`relative overflow-hidden rounded-lg border-2 border-dashed border-border bg-muted/30 ${ratio === "16:9" ? "aspect-[16/9]" : ratio === "3:4" ? "aspect-[3/4]" : "aspect-square"}`}>
        {/* 위험 영역 상단 */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-center bg-error/10 text-xs text-error" style={{ height: dangerHeight }}>
          잘림 위험
        </div>
        {/* 안전 영역 */}
        <div className="absolute inset-x-0 flex items-center justify-center border-y-2 border-dashed border-primary/40 bg-primary/5" style={{ top: dangerHeight, height: safeHeight }}>
          <div className="text-center">
            <p className="text-sm font-bold text-primary">안전 영역</p>
            <p className="text-xs text-primary/70">핵심 정보는 여기에</p>
          </div>
        </div>
        {/* 위험 영역 하단 */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-error/10 text-xs text-error" style={{ height: dangerHeight }}>
          잘림 위험
        </div>
      </div>
    </div>
  );
}

function DisplayPreview({ title, heightPx, description }: { title: string; heightPx: number; description: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-lg border border-border bg-gradient-to-br from-muted to-muted/50"
        style={{ height: `${Math.min(heightPx, 200)}px` }}
      >
        <div className="text-center text-xs text-muted-foreground">
          <p className="font-mono font-bold">{heightPx}px</p>
          <p>{description}</p>
        </div>
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { id: "hero", label: "대표 이미지 (포스터)" },
  { id: "product", label: "상품 이미지" },
  { id: "organizer", label: "주최자 로고" },
  { id: "detail", label: "상세 설명 이미지" },
  { id: "ticket", label: "모바일 티켓" },
  { id: "og", label: "SNS 공유 이미지" },
  { id: "tips", label: "디자인 팁" },
];

export default function DesignGuidePage() {
  return (
    <div className="flex gap-8">
      {/* 사이드 네비게이션 */}
      <nav className="hidden w-52 shrink-0 lg:block">
        <div className="sticky top-24 space-y-1">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">가이드 목차</p>
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {/* 본문 */}
      <div className="min-w-0 flex-1 space-y-12">
        <div>
          <p className="text-sm text-muted-foreground">PICKKET Design Guide</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em]">이미지 디자인 가이드</h1>
          <p className="mt-2 text-muted-foreground">
            이벤트 페이지에 최적화된 이미지를 제작하기 위한 규격과 가이드입니다.
          </p>
        </div>

        {/* ── 01. 대표 이미지 ── */}
        <Section id="hero" title="01. 대표 이미지 (포스터)">
          <p className="mb-4 text-muted-foreground">
            이벤트 페이지 상단, 카드 목록, SNS 공유 시 사용되는 메인 이미지입니다.
            다양한 크기로 잘려서 표시되므로 <strong>핵심 정보는 반드시 중앙에 배치</strong>해주세요.
          </p>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <SpecTable rows={[
              { label: "권장 비율", value: "16:9 (가로형)" },
              { label: "권장 해상도", value: "1920 x 1080px" },
              { label: "최소 해상도", value: "1200 x 675px" },
              { label: "최대 용량", value: "10MB" },
              { label: "허용 포맷", value: "JPG, PNG, WebP, GIF" },
              { label: "색상 모드", value: "RGB (sRGB)" },
            ]} />
            <SafeAreaDiagram ratio="16:9" label="16:9 안전 영역 가이드" safePercent={60} />
          </div>

          <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
            <p className="text-sm font-bold text-warning">세로형 포스터를 사용할 경우</p>
            <p className="mt-1 text-sm text-muted-foreground">
              세로 포스터 (3:4, 2:3)는 16:9 프레임에서 상하가 크게 잘립니다.
              세로 포스터를 그대로 쓰시려면 <strong>16:9 캔버스에 포스터를 배치 + 양옆 배경 채움</strong> 방식을 권장합니다.
            </p>
          </div>

          <h3 className="mb-3 mt-6 text-lg font-bold">표시 위치별 크롭 영역</h3>
          <p className="mb-4 text-sm text-muted-foreground">같은 이미지가 아래 크기로 잘려서 표시됩니다. 모든 곳에서 중앙 기준으로 크롭됩니다.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DisplayPreview title="이벤트 페이지 히어로" heightPx={420} description="데스크탑 기준" />
            <DisplayPreview title="이벤트 카드" heightPx={160} description="목록/그리드" />
            <DisplayPreview title="모바일 히어로" heightPx={360} description="모바일 기준" />
            <DisplayPreview title="모바일 티켓" heightPx={208} description="티켓 상단" />
          </div>
        </Section>

        {/* ── 02. 상품 이미지 ── */}
        <Section id="product" title="02. 상품 이미지">
          <p className="mb-4 text-muted-foreground">
            티켓, 부가상품, 번들 등 상품 카드에 표시되는 이미지입니다.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <SpecTable rows={[
              { label: "권장 비율", value: "1:1 (정사각형)" },
              { label: "권장 해상도", value: "800 x 800px" },
              { label: "최소 해상도", value: "400 x 400px" },
              { label: "최대 용량", value: "10MB" },
              { label: "허용 포맷", value: "JPG, PNG, WebP, GIF" },
            ]} />
            <SafeAreaDiagram ratio="1:1" label="1:1 안전 영역 가이드" safePercent={80} />
          </div>
          <div className="mt-4 rounded-lg bg-muted/50 p-4">
            <p className="text-sm text-muted-foreground">
              상품 목록에서는 정사각형으로 표시됩니다. 텍스트가 포함된 이미지라면 여백을 충분히 확보해주세요.
            </p>
          </div>
        </Section>

        {/* ── 03. 주최자 로고 ── */}
        <Section id="organizer" title="03. 주최자 로고">
          <p className="mb-4 text-muted-foreground">
            이벤트 페이지 주최자 영역과 주최자 프로필에 표시됩니다.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <SpecTable rows={[
              { label: "권장 비율", value: "1:1 (정사각형)" },
              { label: "권장 해상도", value: "400 x 400px" },
              { label: "최소 해상도", value: "200 x 200px" },
              { label: "최대 용량", value: "10MB" },
              { label: "허용 포맷", value: "JPG, PNG (투명 배경 가능), WebP" },
            ]} />
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">로고 안전 영역</p>
              <div className="flex items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/30 p-10">
                <div className="flex size-32 items-center justify-center rounded-full border-2 border-dashed border-primary/40 bg-primary/5">
                  <p className="text-center text-xs text-primary">로고<br />안전 영역</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">원형으로 잘릴 수 있으므로 로고를 중앙에 배치하고 가장자리에 여백을 두세요.</p>
            </div>
          </div>
        </Section>

        {/* ── 04. 상세 설명 이미지 ── */}
        <Section id="detail" title="04. 상세 설명 이미지">
          <p className="mb-4 text-muted-foreground">
            이벤트 상세 설명에 삽입하는 이미지입니다. 별도의 비율 제한은 없지만, 모바일 가독성을 위해 아래 규격을 권장합니다.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <SpecTable rows={[
              { label: "권장 가로폭", value: "최소 750px 이상" },
              { label: "권장 최대 가로폭", value: "1200px (초과 시 자동 축소)" },
              { label: "최대 용량", value: "10MB (큰 파일은 압축 권장)" },
              { label: "허용 포맷", value: "JPG, PNG, WebP, GIF" },
            ]} />
            <div className="space-y-3">
              <p className="text-sm font-medium text-foreground">텍스트 포함 이미지 가이드</p>
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                <ul className="list-inside list-disc space-y-1.5">
                  <li>폰트 크기: <strong>최소 26pt 이상</strong> (모바일 가독성)</li>
                  <li>행간: <strong>최소 37pt 이상</strong> (폰트 26pt 기준)</li>
                  <li>좌우 여백: 이미지 가로폭의 <strong>10% 이상</strong></li>
                  <li>배경 대비: 텍스트와 배경의 <strong>명도차 4.5:1 이상</strong></li>
                </ul>
              </div>
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                <p className="text-xs text-muted-foreground">
                  모바일에서 이미지 내 텍스트가 작으면 읽기 어렵습니다. 긴 텍스트는 이미지 대신 <strong>상세 설명 텍스트 필드</strong>를 사용해주세요.
                </p>
              </div>
            </div>
          </div>
        </Section>

        {/* ── 05. 모바일 티켓 ── */}
        <Section id="ticket" title="05. 모바일 티켓">
          <p className="mb-4 text-muted-foreground">
            구매자가 받는 모바일 티켓 상단에 대표 이미지가 표시됩니다.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <SpecTable rows={[
              { label: "표시 영역", value: "가로 448px x 세로 208px (모바일 기준)" },
              { label: "크롭 방식", value: "중앙 기준 상하좌우 크롭" },
              { label: "오버레이", value: "하단 그라데이션 (텍스트 가독성용)" },
            ]} />
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">모바일 티켓 미리보기</p>
              <div className="mx-auto w-56 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex h-24 items-end justify-center bg-gradient-to-b from-muted to-muted/80 pb-2">
                  <p className="text-xs text-muted-foreground">대표 이미지 영역 (208px)</p>
                </div>
                <div className="space-y-2 p-3">
                  <div className="mx-auto size-16 rounded-lg border border-dashed border-border bg-muted/50 p-1">
                    <p className="text-center text-[8px] text-muted-foreground">QR</p>
                  </div>
                  <div className="h-2 w-3/4 rounded bg-muted" />
                  <div className="h-2 w-1/2 rounded bg-muted" />
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* ── 06. SNS 공유 이미지 ── */}
        <Section id="og" title="06. SNS 공유 이미지 (OG Image)">
          <p className="mb-4 text-muted-foreground">
            카카오톡, 페이스북, 트위터 등에서 링크 공유 시 자동 생성되는 미리보기 이미지입니다.
            별도 업로드가 필요 없으며, 이벤트 정보를 기반으로 <strong>자동 생성</strong>됩니다.
          </p>
          <SpecTable rows={[
            { label: "자동 생성 크기", value: "1200 x 630px (16:9)" },
            { label: "포함 정보", value: "이벤트 제목, 날짜, 장소, 주최자명" },
            { label: "별도 업로드", value: "불필요 (시스템 자동 생성)" },
          ]} />
        </Section>

        {/* ── 07. 디자인 팁 ── */}
        <Section id="tips" title="07. 디자인 팁">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-success/30 bg-success/5 p-4">
              <p className="mb-2 font-bold text-success">권장 사항</p>
              <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>핵심 정보 (로고, 제목, 날짜)는 이미지 <strong>중앙 60%</strong> 영역에 배치</li>
                <li>가로형 (16:9) 이미지를 기본으로 제작</li>
                <li>텍스트 위에 반투명 배경 처리로 가독성 확보</li>
                <li>고해상도 원본 사용 (최소 1200px 이상)</li>
                <li>JPG는 품질 80% 이상으로 저장</li>
                <li>밝은 이미지 + 어두운 텍스트 or 어두운 이미지 + 밝은 텍스트</li>
              </ul>
            </div>
            <div className="rounded-lg border border-error/30 bg-error/5 p-4">
              <p className="mb-2 font-bold text-error">주의 사항</p>
              <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>세로 포스터를 그대로 업로드하면 <strong>상하 50% 이상 잘림</strong></li>
                <li>이미지 가장자리에 중요 정보 배치 금지</li>
                <li>10MB 초과 파일은 업로드 불가</li>
                <li>CMYK 모드 이미지는 색상이 다르게 보일 수 있음</li>
                <li>투명 배경 PNG는 대표 이미지에 부적합 (배경 검정 처리됨)</li>
                <li>이미지 내 작은 텍스트 (14pt 이하)는 모바일에서 판독 불가</li>
              </ul>
            </div>
          </div>

          <h3 className="mb-3 mt-6 text-lg font-bold">세로 포스터 활용법</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-4 text-center">
              <div className="mx-auto mb-2 flex aspect-[16/9] items-center justify-center rounded bg-muted">
                <div className="flex aspect-[3/4] h-[80%] items-center justify-center rounded border border-dashed border-primary/40 bg-primary/5 text-xs text-primary">
                  포스터
                </div>
              </div>
              <p className="text-sm font-medium">방법 1: 16:9 캔버스에 배치</p>
              <p className="text-xs text-muted-foreground">양쪽에 브랜드 컬러 배경</p>
            </div>
            <div className="rounded-lg border border-border p-4 text-center">
              <div className="mx-auto mb-2 flex aspect-[16/9] items-center justify-center overflow-hidden rounded bg-muted">
                <p className="text-xs text-muted-foreground">상단 영역만 크롭</p>
              </div>
              <p className="text-sm font-medium">방법 2: 상단 크롭</p>
              <p className="text-xs text-muted-foreground">포스터 상단부만 16:9로 잘라 사용</p>
            </div>
            <div className="rounded-lg border border-border p-4 text-center">
              <div className="mx-auto mb-2 flex aspect-[16/9] items-center justify-center rounded bg-muted">
                <p className="text-xs text-muted-foreground">별도 가로 배너 제작</p>
              </div>
              <p className="text-sm font-medium">방법 3: 전용 배너 제작</p>
              <p className="text-xs text-muted-foreground">16:9 전용 이미지 별도 디자인</p>
            </div>
          </div>
        </Section>

        <div className="rounded-lg bg-muted/50 p-6 text-center text-sm text-muted-foreground">
          <p>이미지 관련 문의: <strong>support@pickket.kr</strong></p>
          <p className="mt-1">Last Updated: 2026-04-07</p>
        </div>
      </div>
    </div>
  );
}

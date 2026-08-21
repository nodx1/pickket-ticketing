import { Layers, Sparkles, Zap } from "lucide-react";

const items = [
  {
    icon: Sparkles,
    title: "24가지 이벤트 타입",
    description: "강연 · 컨퍼런스 · 축제 · 팝업까지",
  },
  {
    icon: Zap,
    title: "4개 PG 원클릭 연동",
    description: "토스 · 카카오 · 네이버 · 포트원",
  },
  {
    icon: Layers,
    title: "0원으로 시작",
    description: "판매되는 만큼만 수수료",
  },
];

export function TrustStrip() {
  return (
    <div className="mx-auto max-w-7xl px-6 lg:px-10">
      <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:gap-8">
        {items.map((item, idx) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
              {idx < items.length - 1 ? (
                <div className="ml-8 hidden h-8 w-px bg-border sm:block" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

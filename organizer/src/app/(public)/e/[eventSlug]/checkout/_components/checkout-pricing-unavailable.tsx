import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 레벨2 read-flip: 표시/PG 금액을 v2 tier 정본으로 공급하지 못할 때(커머스 미연결·티어 매칭 실패·
 * v2 read 실패)의 안내 화면. go products.price 로 조용히 강등하지 않고 결제 진입을 명시적으로 막는다.
 */
export function CheckoutPricingUnavailable({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto mt-6 max-w-xl">
        <Card className="border-border bg-card/95">
          <CardHeader>
            <CardTitle className="text-2xl font-black tracking-[-0.04em] text-foreground">
              지금은 결제를 진행할 수 없습니다
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{message}</p>
            <p className="text-sm text-muted-foreground">
              잠시 후 다시 시도해 주세요. 문제가 계속되면 주최자에게 문의해 주세요.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

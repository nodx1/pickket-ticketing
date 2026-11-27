import { Badge } from "@/components/ui/badge";

/** 구획 제목 옆에 붙이는 「저장 안 됨」 표시. 저장 버튼이 여러 개인 화면에서 어느 구획을 저장해야 하는지 알려 준다. */
export function UnsavedBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Badge variant="warning" className="ml-2 align-middle">
      저장 안 됨
    </Badge>
  );
}

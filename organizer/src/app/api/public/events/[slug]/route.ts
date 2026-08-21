import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPublicEventBySlug } from "@/lib/server/events";
import { EventAccessError, eventAccessStatus } from "@/lib/v2/event-access";
import { NextRequest } from "next/server";

type Params = { slug: string };

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  const { slug } = await context.params;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format");

  // ── 레벨2 컷오버 W4-EVT ──
  // 이벤트 본문 정본이 v2 로 넘어가면서 getPublicEventBySlug 가 v2 장애 시 EventAccessError 를
  // 던진다. 🔴 이걸 404 로 뭉개면 "공개된 이벤트를 찾을 수 없습니다" 를 보게 되어, 판매중인
  //    행사가 사라진 것처럼 보인다. 재시도 가능 신호(503)로 구분해서 내려준다.
  let event: Awaited<ReturnType<typeof getPublicEventBySlug>>;
  try {
    event = await getPublicEventBySlug(slug, { includeSeats: false });
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    throw err;
  }

  if (!event) {
    return errorResponse("공개된 이벤트를 찾을 수 없습니다", 404);
  }

  // 옛 `as { products?: unknown[] }` 캐스트 제거 — getPublicEventBySlug 는 이제 상품 타입을
  // 명시한다. 캐스트로 타입을 지워두면 아래 alias 매핑에서 **없는 필드**(capacity 등)를 참조해도
  // tsc 가 잡지 못한다. F-6 이 딱 그 방식으로 숨어 있었다.
  const products = event.products.filter((product) => product.isOnSale !== false);

  // v2 포맷: products → seat_tiers alias 추가
  //
  // 🔴 `capacity` 의 뜻(적대 감사 F-6, 2026-07-28) — **총좌석**이다.
  //    종전 `p.capacity ?? p.stock ?? null` 은 `PublicProductRow` 에 `capacity` 가 **없어서**
  //    항상 `p.stock` 폴백을 탔는데, 오늘 `stock` 의 의미가 원본→**잔여**로 바뀌었다.
  //    ⟹ 이 alias 를 v2 `seat_tiers` 로 읽는 소비자는 팔릴수록 줄어드는 값을 "총좌석"으로 받는다.
  //
  //    이름을 값에 맞춘다: 이 alias 는 v2 `seat_tiers` 계약을 흉내 내는 자리이고, v2 에서
  //    `seat_tiers.capacity` 는 집행 **총좌석**이다(잔여는 `capacity − sold_count`).
  //    따라서 `capacity` = 총좌석으로 고정하고(무제한은 null),
  //    잔여·판매수는 **별도 이름**으로 가산한다(`remaining_stock`·`sold_count`).
  //    기존 필드명은 하나도 지우지 않는다 — 가산적 변경이다.
  if (format === "v2") {
    const seatTiers = products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      // 🟡 `sale_mode` 는 **여전히 상수**다(`p.saleMode` 가 상품 타입에 없어 항상 폴백).
      //    실값 전환은 이 응답의 계약 변경이라 소비자 확정 후 별건으로 판단한다.
      //    폴백 뒤에 숨는 대신 상수임을 드러낸다.
      //
      //    ⚠️ 종전엔 이 주석이 `face_price` 도 함께 "상수" 라고 적고 있었다.
      //       2026-08-04 에 `face_price` 만 실값으로 전환했다(아래 참조) — 이 문단은
      //       이제 `sale_mode` 에만 해당한다.
      sale_mode: "fcfs",
      base_price: p.price,
      // 🔴 2026-08-04: 종전엔 `p.price`(판매가) **상수**였다 — 할인 중에도 정가가
      //    판매가로 보였다. 정가 취소선 배정으로 **실값 전환**한다.
      //    소비자 조사: go 의 `?format=v2` 를 런타임에 읽는 코드는 리포에 없다
      //    (organizer 자체 테스트·E2E 뿐. consumer 는 `/bids` 만 go 를 부른다).
      //    ⚠️ `?? p.price` 폴백을 남겨 **null 이 되지 않게** 한다 — 필드를 없애는 것이
      //       아니라 값만 정확해지는 가산적 변경이다.
      face_price: p.facePrice ?? p.price,
      // 총좌석(집행 capacity). `null` = 무제한.
      capacity: p.capacity,
      // 잔여(= capacity − sold_count). `null` = 무제한. 매진 판정은 이 값으로 한다.
      remaining_stock: p.stock,
      // 환불 제외 판매수.
      sold_count: p.soldCount,
    }));

    return successResponse({
      ...event,
      products,
      seat_tiers: seatTiers,
    });
  }

  return successResponse({ ...event, products });
}

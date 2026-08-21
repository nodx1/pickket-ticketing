/**
 * W2-PS 컷오버 백필 — go `products` / `seat_tiers` 메타 → v2 `seat_tiers`.
 *
 * ## 왜 필요한가 (배포 게이트)
 * W2-PS 이후 organizer 는 go 두 테이블을 **읽지 않는다**. 그런데 v2 쪽에는 아래가 비어 있다:
 *   - `stock_limit`(재고 원본) — 신규 컬럼. alembic 백필은 capacity 를 복사할 뿐이라
 *     "무제한 vs 정확히 100만" 구분이 go 값 없이는 불가능하다.
 *   - `color_hex` / `seat_map_id` / `tier_metadata` — 신규 컬럼. **전부 NULL**.
 *   - `tier_metadata.go_source` — 없으면 상품/좌석등급 화면이 서로의 행을 섞어 보여준다.
 *   - T2-ORD 이후 한 번도 저장되지 않은 상품의 설명/세금/정렬/번들 메타.
 *
 * 이 스크립트를 **코드 배포 전에** 돌려야 화면이 옛 값을 잃지 않는다.
 *
 * ## 안전성
 *  - go 는 **읽기만** 한다. 쓰기는 v2 upsert 뿐이다.
 *  - external_ref 기준 멱등 upsert — 여러 번 돌려도 같은 결과다.
 *  - `--dry-run` 으로 먼저 확인한다. 실패한 이벤트는 건너뛰고 마지막에 요약한다
 *    (한 이벤트 실패로 전체가 멈추지 않되, **조용히 성공으로 위장하지 않는다** — exit code 1).
 *
 * 실행: `npx tsx scripts/backfill-tier-catalog.ts [--dry-run] [--event=<uuid>]`
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// .env.local 자동 로딩 (Next.js 외부 실행 시) — migrate.ts 와 동일 관행.
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const dryRun = process.argv.includes("--dry-run");
const onlyEvent = process.argv.find((a) => a.startsWith("--event="))?.slice("--event=".length);

interface GoProductRow {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  price: string;
  stock: number | null;
  min_per_order: number;
  max_per_order: number | null;
  tax_included: boolean;
  tax_rate: number;
  sort_order: number;
  image_url: string | null;
  is_active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  sale_mode: string | null;
  bundle_items: Array<{ productId: string; quantity: number }> | null;
}

interface GoSeatTierRow {
  id: string;
  event_id: string;
  seat_map_id: string | null;
  product_id: string | null;
  name: string;
  capacity: number;
  base_price: string;
  face_price: string;
  sale_mode: string;
  view_description: string | null;
  distance_from_stage: number | null;
  view_rating: number | null;
  view_image_url: string | null;
  position_label: string | null;
  resale_allowed: boolean;
  resale_max_price: string;
  allow_group_tickets: boolean;
  max_group_size: number;
  color_hex: string | null;
  display_order: number;
  metadata: Record<string, unknown> | null;
}

async function main() {
  const { getPool } = await import("@/lib/db/pool");
  const { upsertTierCatalog } = await import("@/lib/v2/commerce-client");
  const { toProductUpsert, toSeatTierUpsert } = await import("@/lib/v2/tier-catalog");

  const pool = getPool();
  const eventFilter = onlyEvent ? "WHERE p.event_id = $1" : "";
  const args = onlyEvent ? [onlyEvent] : [];

  const { rows: products } = await pool.query<GoProductRow>(
    `SELECT p.id, p.event_id, p.name, p.description, p.type, p.visibility, p.price, p.stock,
            p.min_per_order, p.max_per_order, p.tax_included, p.tax_rate, p.sort_order,
            p.image_url, p.is_active, p.sale_starts_at, p.sale_ends_at, p.sale_mode,
            COALESCE(
              (SELECT JSON_AGG(JSONB_BUILD_OBJECT('productId', bi.included_product_id,
                                                  'quantity', bi.quantity))
                 FROM product_bundle_items bi WHERE bi.bundle_product_id = p.id),
              '[]'::json
            ) AS bundle_items
       FROM products p ${eventFilter}
      ORDER BY p.event_id, p.sort_order`,
    args,
  );

  const tierFilter = onlyEvent ? "WHERE t.event_id = $1" : "";
  const { rows: seatTiers } = await pool.query<GoSeatTierRow>(
    `SELECT t.id, t.event_id, t.seat_map_id, t.product_id, t.name, t.capacity, t.base_price,
            t.face_price, t.sale_mode, t.view_description, t.distance_from_stage, t.view_rating,
            t.view_image_url, t.position_label, t.resale_allowed, t.resale_max_price,
            t.allow_group_tickets, t.max_group_size, t.color_hex, t.display_order, t.metadata
       FROM seat_tiers t ${tierFilter}
      ORDER BY t.event_id, t.display_order`,
    args,
  );

  // 이벤트 단위로 묶어 배치 upsert(왕복 최소화). go event id == v2 event id(항등).
  const byEvent = new Map<string, ReturnType<typeof toProductUpsert>[]>();
  const push = (eventId: string, payload: ReturnType<typeof toProductUpsert>) => {
    const list = byEvent.get(eventId) ?? [];
    list.push(payload);
    byEvent.set(eventId, list);
  };

  for (const p of products) {
    push(
      p.event_id,
      toProductUpsert({
        ref: p.id,
        name: p.name,
        description: p.description,
        type: p.type,
        price: Number(p.price ?? 0),
        // 🔴 go 의 재고 원본을 그대로 옮긴다. 종전 write-through 가 0 을 1,000,000 으로
        //    승격시켰던 값도 여기서 정정된다(초과판매 차단).
        stock: p.stock === null ? null : Number(p.stock),
        minPerOrder: p.min_per_order,
        maxPerOrder: p.max_per_order,
        taxIncluded: p.tax_included,
        taxRate: p.tax_rate,
        saleStartsAt: p.sale_starts_at ? new Date(p.sale_starts_at).toISOString() : null,
        saleEndsAt: p.sale_ends_at ? new Date(p.sale_ends_at).toISOString() : null,
        imageUrl: p.image_url,
        visibility: p.visibility,
        isActive: p.is_active,
        sortOrder: p.sort_order,
        saleMode: p.sale_mode,
        bundleItems: p.bundle_items ?? [],
      }),
    );
  }

  for (const t of seatTiers) {
    push(
      t.event_id,
      toSeatTierUpsert({
        ref: t.id,
        name: t.name,
        capacity: t.capacity,
        basePrice: Number(t.base_price ?? 0),
        facePrice: Number(t.face_price ?? 0),
        saleMode: t.sale_mode,
        colorHex: t.color_hex,
        displayOrder: t.display_order,
        seatMapId: t.seat_map_id,
        productId: t.product_id,
        viewDescription: t.view_description,
        distanceFromStage: t.distance_from_stage,
        viewRating: t.view_rating,
        viewImageUrl: t.view_image_url,
        positionLabel: t.position_label,
        resaleAllowed: t.resale_allowed,
        resaleMaxPrice: Number(t.resale_max_price ?? 0),
        allowGroupTickets: t.allow_group_tickets,
        maxGroupSize: t.max_group_size,
      }),
    );
  }

  console.log(
    `백필 대상: 이벤트 ${byEvent.size}건 · 상품 ${products.length}건 · 좌석등급 ${seatTiers.length}건` +
      (dryRun ? " (dry-run — v2 write 없음)" : ""),
  );

  let ok = 0;
  const failed: Array<{ eventId: string; error: string }> = [];
  for (const [eventId, payload] of byEvent) {
    if (dryRun) {
      console.log(`  [dry] ${eventId} → ${payload.length}건`);
      ok += 1;
      continue;
    }
    try {
      // 멱등키를 이벤트+건수로 고정하면 재실행 시 v2 가 옛 응답을 재생할 수 있으므로
      // 실행 시각을 섞어 항상 실제 처리되게 한다(백필은 수렴이 목적).
      await upsertTierCatalog(eventId, payload, {
        idempotencyKey: `w2ps-backfill:${eventId}:${Date.now()}`,
      });
      ok += 1;
      console.log(`  ✓ ${eventId} → ${payload.length}건`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ eventId, error: message });
      console.error(`  ✗ ${eventId} → ${message}`);
    }
  }

  console.log(`\n완료: 성공 ${ok}건 · 실패 ${failed.length}건`);
  if (failed.length > 0) {
    console.error("실패한 이벤트를 해소한 뒤 재실행하세요(멱등).");
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

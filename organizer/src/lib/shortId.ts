import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";

/**
 * DB 기반 고유 주문번호 생성.
 * 인메모리 카운터 대신 DB에서 오늘 날짜의 최대 번호를 조회하여 충돌 방지.
 *
 * ── 레벨2 컷오버 W3-OPS — go read 잔존 사유 ──
 * 시퀀스 원천이 go `orders.order_number` 자신이다. go orders 에 아직 writer 가 있고
 * (`lib/server/orders.ts` = ORD 트랙 소유) 이 함수는 그 INSERT 와 **같은 트랜잭션 client** 를
 * 받아 채번하므로, 여기만 v2 로 돌리면 채번과 INSERT 의 원자성이 깨진다.
 * ⟹ go orders 폐기와 **한 묶음**으로만 이전 가능(그때 채번은 v2 order_number 로 승계).
 *
 * 🔴 알려진 한계(본 트랙 범위 밖, 기록만): `MAX(...)+1` 은 원자적이지 않다. 같은 밀리초에
 *    두 트랜잭션이 같은 max 를 읽으면 동일 번호가 나온다 — 실제 방어는 orders 의 UNIQUE 제약.
 *    v2 이관 시 시퀀스/UNIQUE 기반으로 교정할 것.
 */
export async function generateShortId(prefix = "PKT", client?: PoolClient): Promise<string> {
  const now = new Date();
  const dateKey = [
    String(now.getFullYear()).slice(2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");

  const pattern = `${prefix}-${dateKey}-%`;
  const queryRunner = client ?? getPool();

  const result = await queryRunner.query<{ max_num: string | null }>(
    `SELECT MAX(SUBSTRING(order_number FROM '\\d+$')::int) AS max_num
     FROM orders
     WHERE order_number LIKE $1`,
    [pattern],
  );

  const next = (result.rows[0]?.max_num ? Number(result.rows[0].max_num) : 0) + 1;
  return `${prefix}-${dateKey}-${String(next).padStart(3, "0")}`;
}

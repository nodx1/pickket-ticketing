/**
 * 좌석 티어 리포지토리 — v2 seat_tier 모델 포팅 (Phase 2)
 *
 * 이벤트 단위 티어 CRUD. getPool() 경유하는 전역 쿼리 (트랜잭션 비요구).
 */
import { getPool } from "@/lib/db/pool";
import type { SeatTier } from "./types";

const TIER_COLUMNS = `
  id, account_id, event_id, seat_map_id, product_id, name, capacity, base_price, face_price,
  sale_mode, view_description, distance_from_stage, view_rating, view_image_url, position_label,
  resale_allowed, resale_max_price, allow_group_tickets, max_group_size, color_hex, display_order,
  metadata, created_at, updated_at
`;

function rowToTier(row: Record<string, unknown>): SeatTier {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    eventId: String(row.event_id),
    seatMapId: row.seat_map_id ? String(row.seat_map_id) : null,
    productId: row.product_id ? String(row.product_id) : null,
    name: String(row.name),
    capacity: Number(row.capacity),
    basePrice: Number(row.base_price),
    facePrice: Number(row.face_price),
    saleMode: String(row.sale_mode),
    viewDescription: row.view_description ? String(row.view_description) : null,
    distanceFromStage:
      row.distance_from_stage !== null && row.distance_from_stage !== undefined
        ? Number(row.distance_from_stage)
        : null,
    viewRating:
      row.view_rating !== null && row.view_rating !== undefined
        ? Number(row.view_rating)
        : null,
    viewImageUrl: row.view_image_url ? String(row.view_image_url) : null,
    positionLabel: row.position_label ? String(row.position_label) : null,
    resaleAllowed: Boolean(row.resale_allowed),
    resaleMaxPrice: Number(row.resale_max_price ?? 0),
    allowGroupTickets: Boolean(row.allow_group_tickets),
    maxGroupSize: Number(row.max_group_size ?? 0),
    colorHex: row.color_hex ? String(row.color_hex) : null,
    displayOrder: Number(row.display_order ?? 0),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const tierRepo = {
  async listByEvent(eventId: string, accountId: string): Promise<SeatTier[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT ${TIER_COLUMNS} FROM seat_tiers
       WHERE event_id = $1 AND account_id = $2
       ORDER BY display_order ASC, base_price DESC`,
      [eventId, accountId],
    );
    return rows.map(rowToTier);
  },

  async getById(id: string, accountId: string): Promise<SeatTier | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT ${TIER_COLUMNS} FROM seat_tiers
       WHERE id = $1 AND account_id = $2
       LIMIT 1`,
      [id, accountId],
    );
    return rows[0] ? rowToTier(rows[0]) : null;
  },

  async create(args: {
    accountId: string;
    eventId: string;
    seatMapId?: string | null;
    productId?: string | null;
    name: string;
    capacity: number;
    basePrice: number;
    facePrice?: number;
    saleMode?: string;
    colorHex?: string;
    displayOrder?: number;
  }): Promise<SeatTier> {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO seat_tiers (
        account_id, event_id, seat_map_id, product_id, name, capacity, base_price, face_price,
        sale_mode, color_hex, display_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING ${TIER_COLUMNS}`,
      [
        args.accountId,
        args.eventId,
        args.seatMapId ?? null,
        args.productId ?? null,
        args.name,
        args.capacity,
        args.basePrice,
        args.facePrice ?? args.basePrice,
        args.saleMode ?? "fixed_fcfs",
        args.colorHex ?? null,
        args.displayOrder ?? 0,
      ],
    );
    return rowToTier(rows[0]);
  },

  async update(
    id: string,
    accountId: string,
    updates: Partial<{
      name: string;
      capacity: number;
      basePrice: number;
      facePrice: number;
      saleMode: string;
      viewDescription: string;
      distanceFromStage: number;
      viewRating: number;
      viewImageUrl: string;
      positionLabel: string;
      resaleAllowed: boolean;
      resaleMaxPrice: number;
      allowGroupTickets: boolean;
      maxGroupSize: number;
      colorHex: string;
      displayOrder: number;
    }>,
  ): Promise<SeatTier | null> {
    const pool = getPool();
    const fieldMap: Record<string, string> = {
      name: "name",
      capacity: "capacity",
      basePrice: "base_price",
      facePrice: "face_price",
      saleMode: "sale_mode",
      viewDescription: "view_description",
      distanceFromStage: "distance_from_stage",
      viewRating: "view_rating",
      viewImageUrl: "view_image_url",
      positionLabel: "position_label",
      resaleAllowed: "resale_allowed",
      resaleMaxPrice: "resale_max_price",
      allowGroupTickets: "allow_group_tickets",
      maxGroupSize: "max_group_size",
      colorHex: "color_hex",
      displayOrder: "display_order",
    };
    const sets: string[] = [];
    const params: unknown[] = [id, accountId];
    for (const [k, v] of Object.entries(updates)) {
      const col = fieldMap[k];
      if (col && v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 0) return this.getById(id, accountId);
    sets.push(`updated_at = NOW()`);
    const { rows } = await pool.query(
      `UPDATE seat_tiers SET ${sets.join(", ")}
       WHERE id = $1 AND account_id = $2
       RETURNING ${TIER_COLUMNS}`,
      params,
    );
    return rows[0] ? rowToTier(rows[0]) : null;
  },

  async delete(id: string, accountId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM seat_tiers WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};

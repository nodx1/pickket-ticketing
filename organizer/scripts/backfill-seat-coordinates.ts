/**
 * 좌석 격자 좌표 + quality_score 백필 스크립트 (트랙 7.13)
 *
 * 기존 80여 개 이벤트의 좌석들이 x/y/quality_score NULL 상태일 수 있다.
 * 이 스크립트는 section/row/seat_number 기반으로 격자 좌표를 자동 부여하고,
 * 무대 거리 추정값으로 quality_score 를 계산한다.
 *
 * 사용:
 *   npx tsx scripts/backfill-seat-coordinates.ts            # dry-run
 *   npx tsx scripts/backfill-seat-coordinates.ts --apply    # 실제 UPDATE
 *   npx tsx scripts/backfill-seat-coordinates.ts --apply --map <mapId>  # 단일 맵
 */

import { getPool } from "@/lib/db/pool";

interface SeatRow {
  id: string;
  seat_map_id: string;
  section: string;
  row: string;
  seat_number: string;
  x: number | null;
  y: number | null;
  quality_score: number | null;
}

const APPLY = process.argv.includes("--apply");
const MAP_ARG_IDX = process.argv.indexOf("--map");
const ONLY_MAP =
  MAP_ARG_IDX > -1 && process.argv[MAP_ARG_IDX + 1]
    ? process.argv[MAP_ARG_IDX + 1]
    : null;

function parseNumericSuffix(value: string): number {
  const m = value.match(/\d+/g);
  if (!m || m.length === 0) return 0;
  return Number.parseInt(m[m.length - 1] ?? "0", 10) || 0;
}

async function main(): Promise<void> {
  const pool = getPool();
  console.log(
    `[backfill] mode=${APPLY ? "APPLY" : "DRY-RUN"} ${ONLY_MAP ? `map=${ONLY_MAP}` : "all maps"}`,
  );

  const params: unknown[] = [];
  let where = "WHERE (s.x IS NULL OR s.y IS NULL OR s.quality_score IS NULL)";
  if (ONLY_MAP) {
    params.push(ONLY_MAP);
    where += ` AND s.seat_map_id = $${params.length}`;
  }

  const { rows } = await pool.query<SeatRow>(
    `
    SELECT s.id, s.seat_map_id, s.section, s.row, s.seat_number,
           s.x, s.y, s.quality_score
    FROM seats s
    ${where}
    ORDER BY s.seat_map_id, s.section, s.row, s.seat_number
    `,
    params,
  );

  console.log(`[backfill] target rows: ${rows.length}`);
  if (rows.length === 0) {
    console.log("[backfill] nothing to do");
    return;
  }

  // 좌석맵별로 그룹화 → 행 인덱스 부여 → 격자 좌표 계산
  const byMap = new Map<string, SeatRow[]>();
  for (const r of rows) {
    const arr = byMap.get(r.seat_map_id) ?? [];
    arr.push(r);
    byMap.set(r.seat_map_id, arr);
  }

  let updated = 0;
  for (const [mapId, mapRows] of byMap.entries()) {
    const rowSet = new Set<string>();
    for (const r of mapRows) rowSet.add(r.row);
    const rowList = Array.from(rowSet).sort((a, b) => a.localeCompare(b));
    const rowIndex = new Map<string, number>();
    rowList.forEach((row, idx) => rowIndex.set(row, idx));
    const maxRowIdx = Math.max(1, rowList.length - 1);

    for (const r of mapRows) {
      const x = r.x ?? parseNumericSuffix(r.seat_number);
      const y = r.y ?? (rowIndex.get(r.row) ?? 0);
      // quality_score: 무대 가까울수록 1.0 (행 인덱스 0이 무대 앞이라 가정)
      const distanceRatio = (rowIndex.get(r.row) ?? 0) / maxRowIdx;
      const quality = r.quality_score ?? Math.max(0.1, 1 - distanceRatio);

      if (APPLY) {
        await pool.query(
          `UPDATE seats SET x = $1, y = $2, quality_score = $3, updated_at = NOW() WHERE id = $4`,
          [x, y, quality, r.id],
        );
      }
      updated += 1;
    }
    console.log(
      `[backfill] map=${mapId} rows=${mapRows.length} ${APPLY ? "applied" : "would-apply"}`,
    );
  }

  console.log(
    `[backfill] DONE — ${updated} rows ${APPLY ? "updated" : "(dry-run, use --apply to commit)"}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});

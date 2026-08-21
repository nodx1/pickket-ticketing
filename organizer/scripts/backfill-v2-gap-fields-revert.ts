/**
 * Phase 1-B 역보정(롤백) — backfill-v2-gap-fields.ts 가 남긴 스냅샷을 v2 에 재PUT 해
 * content(참석진/공지/시설)를 백필 이전 상태로 복원한다.
 *
 * 스냅샷 파일(backfill-v2-gap-fields.snapshot.<ts>.json)은 --apply 백필 직전에 각 이벤트의
 * v2 content 를 캡처해둔 것이다. content 는 PUT 전량교체라 백필이 v2 를 덮어썼으므로, 이 스냅샷을
 * 그대로 재PUT 하면 백필 이전으로 되돌아간다.
 *
 * ⚠️ 범위: content 만 복원한다. gap 필드/seat_map_data 는 PATCH(누적교체)라 revert 옵션 2가지:
 *   (a) --clear-gap  : gap/seat_map 을 명시 null/빈배열로 PUT → 백필분 제거(단, 백필 전에 이미
 *                       값이 있었다면 그것도 지움 — content 처럼 정밀복원 아님, 거친 clear).
 *   기본은 content 만 복원(gap 은 그대로 둠). gap 은 소비자 노출이 "추가 정보"라 잔존해도 무해하며,
 *   정밀 복원이 필요하면 백필 스냅샷에 gap-before 를 추가하는 별도 버전을 쓴다.
 *
 * 사용:
 *   npx tsx scripts/backfill-v2-gap-fields-revert.ts <snapshot.json>            # dry-run
 *   npx tsx scripts/backfill-v2-gap-fields-revert.ts <snapshot.json> --apply    # content 복원
 *   npx tsx scripts/backfill-v2-gap-fields-revert.ts <snapshot.json> --apply --clear-gap
 *
 * ⚠️ 실행 금지(작성만). 로컬 dev·대표 승인 하에서만.
 */

import { readFileSync } from "node:fs";

import {
  upsertEventContent,
  updateEvent,
  goAccountRef,
  V2CommerceError,
  type EventContentInput,
} from "@/lib/v2/commerce-client";
import { getPool } from "@/lib/db/pool";

const APPLY = process.argv.includes("--apply");
const CLEAR_GAP = process.argv.includes("--clear-gap");

interface SnapshotEntry {
  goEventId: string;
  v2EventId: string;
  contentBefore: EventContentInput;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("사용법: npx tsx scripts/backfill-v2-gap-fields-revert.ts <snapshot.json> [--apply] [--clear-gap]");
    process.exit(2);
  }

  const raw = readFileSync(file, "utf8");
  const snapshots = JSON.parse(raw) as SnapshotEntry[];
  console.log(`[revert] mode=${APPLY ? "APPLY" : "DRY-RUN"} clearGap=${CLEAR_GAP} entries=${snapshots.length} file=${file}`);

  const pool = getPool();
  let restored = 0;
  let failed = 0;

  for (const s of snapshots) {
    // account_id 는 gap clear PATCH 의 organizer_ref 에 필요 → go events 앵커에서 재조회(경계 유지).
    let accountId: string | null = null;
    if (CLEAR_GAP) {
      const { rows } = await pool.query<{ account_id: string }>(
        `SELECT account_id FROM events WHERE id = $1 LIMIT 1`,
        [s.goEventId],
      );
      accountId = rows[0]?.account_id ?? null;
    }

    if (!APPLY) {
      const c = s.contentBefore;
      console.log(
        `[dry] event=${s.goEventId} v2=${s.v2EventId} restore content ` +
          `part=${c.participants?.length ?? 0} notice=${c.notices?.length ?? 0} fac=${c.facilities?.length ?? 0}` +
          (CLEAR_GAP ? " + clear-gap" : ""),
      );
      continue;
    }

    try {
      // content 전량 복원(백필 이전 상태 재PUT).
      await upsertEventContent(s.v2EventId, s.contentBefore, {
        idempotencyKey: `revert-content:${s.goEventId}:${Date.now()}`,
      });

      if (CLEAR_GAP && accountId) {
        // gap/seat_map 을 명시 null/빈배열로 clear(백필분 제거). 거친 복원(백필 전 값도 제거될 수 있음).
        await updateEvent(
          s.v2EventId,
          {
            organizer_ref: goAccountRef(accountId),
            summary: null,
            event_schedules: [],
            seo_metadata: null,
            questions: [],
            transport_info: null,
            parking_info: null,
            runtime_minutes: null,
            intermission_minutes: null,
            seat_map_data: null,
          },
          { idempotencyKey: `revert-gap:${s.goEventId}:${Date.now()}` },
        );
      }
      restored += 1;
      console.log(`[apply] event=${s.goEventId} restored${CLEAR_GAP ? " + gap cleared" : ""}`);
    } catch (err: unknown) {
      failed += 1;
      const msg = err instanceof V2CommerceError ? `V2CommerceError(${err.status}) ${err.message}` : String(err);
      console.error(`[apply][FAIL] event=${s.goEventId}: ${msg}`);
    }
  }

  console.log(`[revert] DONE — entries=${snapshots.length} ${APPLY ? `restored=${restored} failed=${failed}` : "(dry-run)"}`);
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[revert] FATAL:", err);
  process.exit(1);
});

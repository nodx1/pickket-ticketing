/**
 * Phase 1-B — 기존 go 이벤트의 "상세페이지 갭 필드"를 v2(소비자 상세 SoT)로 1회 백필.
 *
 * 배경: 1-S/1-O/1-Map 이전에 생성된 go 이벤트는 갭 필드(summary·event_schedules·seo_metadata·
 * questions·transport_info·parking_info·runtime/intermission·seat_map_data·공동주최자·
 * content[참석진/공지/시설])가 go 에만 있고 v2 에 미반영이다. 이후 write-through 는 "편집 시점"에만
 * 전파되므로, 편집이 없는 과거 이벤트는 영구 stale 이다. 이 스크립트가 1회 수렴시킨다.
 *
 * 재사용: 신규 write-through 헬퍼를 그대로 호출한다(SoT 단일화, 로직 중복 없음).
 *  - pushEventGapFields  : summary/schedules/seo/questions/transport/parking/runtime/intermission
 *  - (seat_map_data 백필 제거 — 3.1: 빌더 라우트가 편집 delta 로 live 유지, go-read 없음)
 *  - pushTeamMemberToV2  : event_organizers → v2 organizer_team_members(공동주최자)
 *  - content(참석진/공지/시설) : upsertEventContent PUT(전량 교체) — 아래 collectAndPushContent
 *
 * 안전 설계:
 *  - **dry-run 우선**: 기본은 집계만 출력(대상 수·섹션별 존재 여부). --apply 로만 실제 write.
 *  - **멱등**: 각 push 는 v2 upsert/PUT(external_ref·PUT 전량교체) — N회 실행해도 수렴값 동일.
 *    fingerprint(1-Sync) 덕에 값 변경 시 replay 없이 반영, 값 동일 시 replay(무해).
 *  - **역보정 동반**: --apply 시 각 이벤트의 v2 갭필드 "이전 상태"를 스냅샷 파일로 남긴다
 *    (`backfill-v2-gap-fields.snapshot.<ts>.json`). 롤백은 backfill-v2-gap-fields-revert.ts 가
 *    이 스냅샷을 v2 에 재PUT(=백필 이전으로 복원).
 *  - **account 경계**: 이벤트별 account_id 로만 조회·push(크로스테넌트 누출 차단).
 *  - **비파괴**: v2 앵커(v2_event_id) 미준비 이벤트는 스킵(백필 대상 아님 — 앵커 확립이 선행).
 *
 * 사용:
 *   npx tsx scripts/backfill-v2-gap-fields.ts                  # dry-run(집계만)
 *   npx tsx scripts/backfill-v2-gap-fields.ts --event <goId>   # 단일 이벤트 dry-run
 *   npx tsx scripts/backfill-v2-gap-fields.ts --apply          # 실제 백필(+스냅샷)
 *   npx tsx scripts/backfill-v2-gap-fields.ts --apply --limit 20
 *
 * ⚠️ 실행 금지(작성만) — prod DB/v2 실호출은 대표 승인·게이트 필요. 로컬 dev 에서만.
 *
 * 🔴 **레거시 경고 (레벨2 컷오버 이후 이 스크립트는 부분 무효다)**
 *   이 스크립트가 읽는 go 테이블 여러 개가 후속 컷오버에서 이미 DROP 됐거나 DROP 예정이다:
 *     · `event_schedules`  — mig240 DROP (정본 = v2 `events.event_schedules`)
 *     · `seat_maps`        — 좌석 컷오버(T1)로 정본이 v2 로 이동
 *     · `event_organizers` — W2-EVT 로 v2 `event_host_links` 이관
 *     · `event_questions`  — **W5-ATTENDEE** 로 v2 `event_questions` 이관 (mig252 DROP)
 *   즉 "go 에만 있는 갭을 v2 로 밀어넣는다"는 이 스크립트의 전제 자체가 사라졌다.
 *   W5 에서는 자기 의존분(`pushEventGapFields`·`event_questions` 프로브)만 제거했다.
 *   **폐기 판단은 상세통합/이벤트 트랙 소유** — 남은 content/공동주최자 백필도 소스 테이블이
 *   없으므로 실행하면 즉시 실패한다. 실행하지 말 것.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getPool } from "@/lib/db/pool";
import {
  getEventContent,
  upsertEventContent,
  V2CommerceError,
  type EventContentInput,
} from "@/lib/v2/commerce-client";
import { pushTeamMemberToV2 } from "@/lib/v2/organizer-sync";

const APPLY = process.argv.includes("--apply");
const EVENT_ARG = argValue("--event");
const LIMIT = Number.parseInt(argValue("--limit") ?? "0", 10) || 0;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

interface EventRow {
  id: string;
  account_id: string;
  title: string | null;
  v2_event_id: string | null;
}

interface EventGapPresence {
  summary: boolean;
  schedules: number;
  questions: number;
  transport: boolean;
  parking: boolean;
  runtime: boolean;
  seoMetadata: boolean;
  seatMaps: number;
  coOrganizers: number;
  participants: number;
  notices: number;
  facilities: number;
}

interface SnapshotEntry {
  goEventId: string;
  v2EventId: string;
  /** 백필 이전 v2 content(참석진/공지/시설) — revert 가 그대로 재PUT. */
  contentBefore: EventContentInput;
}

// ── go 측 갭필드 존재 여부 집계(dry-run 리포트용, write 아님) ──────────────────

async function collectPresence(
  db: ReturnType<typeof getPool>,
  ev: EventRow,
): Promise<EventGapPresence> {
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    db.query<T>(sql, params).then((r) => r.rows);

  const [evGap] = await q<{
    summary: string | null;
    transport_info: string | null;
    parking_info: string | null;
    runtime_minutes: number | null;
    intermission_minutes: number | null;
    seo_metadata: Record<string, unknown> | null;
  }>(
    `SELECT summary, transport_info, parking_info, runtime_minutes, intermission_minutes, seo_metadata
       FROM events WHERE id = $1 AND account_id = $2 LIMIT 1`,
    [ev.id, ev.account_id],
  );

  const [sch] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM event_schedules WHERE event_id = $1`,
    [ev.id],
  );
  const [maps] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM seat_maps WHERE event_id = $1 AND status = 'published'`,
    [ev.id],
  );
  const [co] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM event_organizers WHERE event_id = $1 AND account_id = $2`,
    [ev.id, ev.account_id],
  );
  const [parts] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM event_participants WHERE event_id = $1 AND account_id = $2 AND is_visible = true`,
    [ev.id, ev.account_id],
  );
  const [notes] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM open_notices WHERE event_id = $1 AND account_id = $2 AND is_published = true`,
    [ev.id, ev.account_id],
  );
  const [facs] = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM event_facilities WHERE event_id = $1 AND account_id = $2`,
    [ev.id, ev.account_id],
  );

  const seo = evGap?.seo_metadata;
  const seoHas =
    !!seo &&
    typeof seo === "object" &&
    Object.values(seo).some((v) => v !== null && v !== undefined && v !== "");

  return {
    summary: !!evGap?.summary,
    schedules: Number(sch?.n ?? 0),
    // W5-ATTENDEE: go `event_questions` 이관(mig252 DROP) → 프로브 제거, 항상 0.
    questions: 0,
    transport: !!evGap?.transport_info,
    parking: !!evGap?.parking_info,
    runtime: evGap?.runtime_minutes != null || evGap?.intermission_minutes != null,
    seoMetadata: seoHas,
    seatMaps: Number(maps?.n ?? 0),
    coOrganizers: Number(co?.n ?? 0),
    participants: Number(parts?.n ?? 0),
    notices: Number(notes?.n ?? 0),
    facilities: Number(facs?.n ?? 0),
  };
}

function presenceHasAnything(p: EventGapPresence): boolean {
  return (
    p.summary ||
    p.schedules > 0 ||
    p.questions > 0 ||
    p.transport ||
    p.parking ||
    p.runtime ||
    p.seoMetadata ||
    p.seatMaps > 0 ||
    p.coOrganizers > 0 ||
    p.participants > 0 ||
    p.notices > 0 ||
    p.facilities > 0
  );
}

// ── content(참석진/공지/시설) collect + push (라우트 SQL 과 동일 규칙) ─────────

async function collectContentFromGo(
  db: ReturnType<typeof getPool>,
  ev: EventRow,
): Promise<EventContentInput> {
  const { rows: parts } = await db.query<{
    name: string;
    role: string | null;
    bio: string | null;
    image_url: string | null;
    sort_order: number;
  }>(
    `SELECT name, role, bio, image_url, sort_order
       FROM event_participants
      WHERE event_id = $1 AND account_id = $2 AND is_visible = true ORDER BY sort_order`,
    [ev.id, ev.account_id],
  );
  const { rows: notes } = await db.query<{
    type: string;
    title: string;
    content: string | null;
    published_at: Date | string | null;
  }>(
    `SELECT type, title, content, published_at
       FROM open_notices
      WHERE event_id = $1 AND account_id = $2 AND is_published = true
      ORDER BY published_at DESC NULLS LAST, created_at DESC`,
    [ev.id, ev.account_id],
  );
  const { rows: facs } = await db.query<{
    name: string;
    category: string | null;
    quantity: number | null;
    status: string | null;
  }>(
    `SELECT name, category, quantity, status
       FROM event_facilities WHERE event_id = $1 AND account_id = $2 ORDER BY category, name`,
    [ev.id, ev.account_id],
  );

  return {
    participants: parts.map((p) => ({
      name: p.name,
      role: p.role,
      bio: p.bio,
      image_url: p.image_url,
      sort_order: p.sort_order,
    })),
    notices: notes.map((n) => ({
      title: n.title,
      notice_type: n.type,
      content: n.content,
      published_at:
        n.published_at == null
          ? null
          : n.published_at instanceof Date
            ? n.published_at.toISOString()
            : n.published_at,
    })),
    facilities: facs.map((f) => ({
      name: f.name,
      category: f.category,
      quantity: f.quantity,
      status: f.status,
    })),
  };
}

// ── 실행 ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = getPool();
  console.log(`[backfill-gap] mode=${APPLY ? "APPLY" : "DRY-RUN"}${EVENT_ARG ? ` event=${EVENT_ARG}` : ""}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  const params: unknown[] = [];
  let where = "WHERE v2_event_id IS NOT NULL"; // 앵커 확립된 이벤트만(백필 대상).
  if (EVENT_ARG) {
    params.push(EVENT_ARG);
    where += ` AND id = $${params.length}`;
  }
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
  const { rows: events } = await pool.query<EventRow>(
    `SELECT id, account_id, title, v2_event_id FROM events ${where} ORDER BY created_at ASC ${limitClause}`,
    params,
  );

  console.log(`[backfill-gap] candidate events (v2-anchored): ${events.length}`);

  const snapshots: SnapshotEntry[] = [];
  let withData = 0;
  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const ev of events) {
    const presence = await collectPresence(pool, ev);
    const has = presenceHasAnything(presence);
    if (has) withData += 1;

    const summary = `event=${ev.id} "${ev.title ?? ""}" ` +
      `summary=${presence.summary ? "Y" : "-"} sched=${presence.schedules} q=${presence.questions} ` +
      `transport=${presence.transport ? "Y" : "-"} parking=${presence.parking ? "Y" : "-"} runtime=${presence.runtime ? "Y" : "-"} ` +
      `seo=${presence.seoMetadata ? "Y" : "-"} seatmaps=${presence.seatMaps} co-org=${presence.coOrganizers} ` +
      `part=${presence.participants} notice=${presence.notices} fac=${presence.facilities}`;

    if (!APPLY) {
      console.log(`[dry] ${summary}`);
      continue;
    }

    if (!has) {
      skipped += 1;
      continue; // 밀어넣을 갭 데이터 없음 — v2 를 건드리지 않음(빈 PUT 로 v2 clear 하지 않기 위함).
    }

    try {
      // 1) 역보정 스냅샷: content 는 PUT 전량교체라 이전 v2 상태를 반드시 스냅샷(revert 근거).
      //    (gap/seat_map 은 PATCH — revert 스크립트가 null 로 clear 하거나 스냅샷 복원)
      const before = await getEventContent(ev.v2_event_id!);
      snapshots.push({
        goEventId: ev.id,
        v2EventId: ev.v2_event_id!,
        contentBefore: {
          participants: before.participants,
          notices: before.notices,
          facilities: before.facilities,
        },
      });

      // 2) gap 필드(PATCH) 백필 제거 — W2-EVT/W5-ATTENDEE 로 summary/schedules/seo/questions 의
      //    정본이 전부 v2 로 옮겨졌다. go 에서 읽어 밀어넣을 소스가 더는 없다(위 레거시 경고).
      // 3) seat_map_data 백필 제거(레벨2 3차 3.1) — 배치도 원본 sync 는 go-read 를 제거하고 빌더 라우트가
      //    편집 delta 로 live 유지한다(seat-map-payload.pushSeatMapData delta). go seat 테이블 DROP 대비.
      //    (레거시 이벤트는 빌더에서 1회 저장 시 수렴 — 실데이터 0 이라 무해.)
      // 4) content(PUT 전량교체) — 참석진/공지/시설.
      const content = await collectContentFromGo(pool, ev);
      await upsertEventContent(ev.v2_event_id!, content, {
        idempotencyKey: `backfill-content:${ev.id}:${Date.now()}`,
      });
      // 5) 공동주최자 — event_organizers 각 행을 v2 팀멤버로 미러(매핑 누락 행은 헬퍼가 스킵).
      const { rows: eoRows } = await pool.query<{ id: string }>(
        `SELECT id FROM event_organizers WHERE event_id = $1 AND account_id = $2`,
        [ev.id, ev.account_id],
      );
      for (const eo of eoRows) await pushTeamMemberToV2(eo.id);

      // organizer_ref 는 gap/seat push 가 이미 실어보냄. content push 는 event_id 로 스코프됨.
      pushed += 1;
      console.log(`[apply] ${summary} → pushed`);
    } catch (err: unknown) {
      failed += 1;
      const msg = err instanceof V2CommerceError ? `V2CommerceError(${err.status}) ${err.message}` : String(err);
      console.error(`[apply][FAIL] event=${ev.id}: ${msg}`);
      // 계속 진행(이벤트 단위 격리) — 한 건 실패가 전체 백필을 막지 않음. 실패 목록은 종료 시 요약.
    }
  }

  if (APPLY && snapshots.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = resolve(process.cwd(), `backfill-v2-gap-fields.snapshot.${ts}.json`);
    writeFileSync(file, JSON.stringify(snapshots, null, 2), "utf8");
    console.log(`[backfill-gap] 역보정 스냅샷 저장: ${file} (${snapshots.length} 이벤트)`);
    console.log(`[backfill-gap] 롤백: npx tsx scripts/backfill-v2-gap-fields-revert.ts ${file}`);
  }

  console.log(
    `[backfill-gap] DONE — candidates=${events.length} withData=${withData} ` +
      (APPLY ? `pushed=${pushed} skipped=${skipped} failed=${failed}` : "(dry-run, use --apply)"),
  );
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[backfill-gap] FATAL:", err);
  process.exit(1);
});

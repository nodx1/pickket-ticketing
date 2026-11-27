/**
 * 과업 화면(가중치 추첨 설정 · 공정성 증명서 · 현장 입장 관리 · 정산 방식) → v2 내부 API 프록시.
 *
 * 🔴 모든 요청은 먼저 **이 주최사의 이벤트인지** 확인한다(getOwnedEvent — v2 가 organizer_ref 경계 강제).
 * 🔴 경로는 아래 허용 표에 있는 것만 통과한다. 표에 없는 경로·메서드는 404.
 * 🔴 하위 자원(풀·증명서·PG 계정)은 이 이벤트에 속하는지 한 번 더 확인한다.
 */
import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { EventAccessError, eventAccessStatus, getOwnedEvent } from "@/lib/v2/event-access";
import {
  type CertificateView,
  type FairnessPool,
  type MaskedEntry,
  type SettlementOverview,
  V2GwasupError,
  realtimeBaseUrl,
  v2Get,
  v2Public,
  v2Write,
} from "@/lib/v2/gwasup-client";
import type { User } from "@/lib/types";

type Params = { eventId: string; path: string[] };
type Ctx = { eventId: string; path: string[]; organizerId: string; actor: string; request: NextRequest };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CERT_RE = /^PKT-FC-\d{4}-\d{6}$/;

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function assertPoolInEvent(eventId: string, poolId: string): Promise<FairnessPool> {
  if (!UUID_RE.test(poolId)) throw new V2GwasupError("잘못된 추첨 풀입니다", 404);
  const overview = await v2Get<{ pools: FairnessPool[] }>(`/internal/events/${eventId}/fairness`);
  const pool = overview.pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new V2GwasupError("이 이벤트의 추첨이 아닙니다", 404);
  return pool;
}

async function certificateFor(eventId: string, certNo: string): Promise<CertificateView> {
  if (!CERT_RE.test(certNo)) throw new V2GwasupError("잘못된 증명서 번호입니다", 404);
  const res = await v2Public(`/fairness/certificates/${encodeURIComponent(certNo)}`);
  if (!res.ok) throw new V2GwasupError("증명서를 찾을 수 없습니다", res.status);
  const view = (await res.json()) as CertificateView;
  if (view.payload.event.id !== eventId) throw new V2GwasupError("이 이벤트의 증명서가 아닙니다", 404);
  return view;
}

function csv(rows: MaskedEntry[]): string {
  const head = ["응모번호", "이름", "연락처", "결과", "투입AP", "가중치", "인원", "응모시각"];
  const label: Record<string, string> = { won: "당첨", waitlisted: "대기", pending: "진행중", excluded: "제재 제외" };
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.entry_id, r.name, r.phone, label[r.result] ?? r.result, r.invested_ap, r.weight ?? "", r.group_size, r.applied_at ?? ""].map(esc).join(","),
  );
  return "﻿" + [head.join(","), ...lines].join("\n");
}

async function handleGet(ctx: Ctx): Promise<Response> {
  const { eventId, path, request } = ctx;
  const key = path.join("/");
  const q = request.nextUrl.searchParams;

  if (key === "lottery-policy") return successResponse(await v2Get(`/internal/events/${eventId}/lottery-policy`));
  if (key === "fairness") return successResponse(await v2Get(`/internal/events/${eventId}/fairness`));
  if (path[0] === "fairness" && path[1] === "pools" && path[3] === "results" && path.length === 4) {
    await assertPoolInEvent(eventId, path[2]);
    const data = await v2Get<{ entries: MaskedEntry[]; roots: unknown }>(`/internal/lottery/pools/${path[2]}/results`);
    if (q.get("format") === "csv") {
      return new NextResponse(csv(data.entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="lottery-results-${path[2].slice(0, 8)}.csv"`,
        },
      });
    }
    return successResponse(data);
  }
  if (path[0] === "fairness" && path[1] === "certificates" && path.length === 3) {
    return successResponse(await certificateFor(eventId, path[2]));
  }
  if (path[0] === "fairness" && path[1] === "certificates" && path[3] === "pdf" && path.length === 4) {
    await certificateFor(eventId, path[2]);
    const res = await v2Public(`/fairness/certificates/${encodeURIComponent(path[2])}/pdf`);
    return new NextResponse(await res.arrayBuffer(), {
      status: res.status,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${path[2]}.pdf"` },
    });
  }
  if (key === "onsite") return successResponse(await v2Get(`/internal/events/${eventId}/onsite`));
  if (key === "onsite/monitor-token") {
    const token = await v2Get<{ token: string; expires_at: number }>(`/internal/events/${eventId}/monitor-token`);
    return successResponse({ ...token, url: realtimeBaseUrl(), path: "/ws/socket.io" });
  }
  if (key === "onsite/timeseries") {
    const kind = q.get("kind") === "lottery" ? "lottery" : "admission";
    const minutes = Math.max(1, Math.min(Number(q.get("minutes") ?? 120) || 120, 20160));
    return successResponse(await v2Get(`/internal/events/${eventId}/timeseries?kind=${kind}&minutes=${minutes}`));
  }
  if (key === "sanctions") return successResponse(await v2Get(`/internal/events/${eventId}/sanctions`));
  if (key === "settlement") return successResponse(await v2Get(`/internal/events/${eventId}/settlement`));
  if (key === "ledger") {
    const cp = q.get("counterpart");
    const suffix = cp && ["pg", "terminal", "partner", "webhook"].includes(cp) ? `&counterpart=${cp}` : "";
    return successResponse(await v2Get(`/internal/integration-ledger?event_id=${eventId}&limit=100${suffix}`));
  }
  if (key === "ledger/verify") return successResponse(await v2Get(`/internal/integration-ledger/verify`));
  return errorResponse("지원하지 않는 요청입니다", 404);
}

async function handleWrite(method: "POST" | "PUT" | "PATCH", ctx: Ctx): Promise<Response> {
  const { eventId, path, actor, organizerId } = ctx;
  const body = { ...(await readJson(ctx.request)), actor };
  const key = path.join("/");

  if (method === "PUT" && key === "lottery-policy") {
    return successResponse(await v2Write("PUT", `/internal/events/${eventId}/lottery-policy`, body, "gwasup.lottery-policy.save"));
  }
  if (method === "POST" && key === "lottery-policy/simulate") {
    return successResponse(await v2Write("POST", `/internal/lottery-policy/simulate`, body, "gwasup.lottery-policy.simulate", 30_000));
  }
  // 주최사 「지금 추첨하기」 — 응모 마감 뒤에만(v2 가 마감·이중 추첨을 다시 확인한다).
  if (method === "POST" && path[0] === "fairness" && path[1] === "pools" && path[3] === "draw" && path.length === 4) {
    await assertPoolInEvent(eventId, path[2]);
    return successResponse(await v2Write("POST", `/internal/lottery/pools/${path[2]}/draw`, body, "gwasup.lottery.draw", 20_000));
  }
  if (method === "POST" && path[0] === "fairness" && path[1] === "pools" && path[3] === "certificate" && path.length === 4) {
    await assertPoolInEvent(eventId, path[2]);
    return successResponse(await v2Write("POST", `/internal/lottery/pools/${path[2]}/certificate`, body, "gwasup.certificate.issue"));
  }
  if (method === "POST" && key === "onsite/terminals") {
    return successResponse(await v2Write("POST", `/internal/events/${eventId}/terminals`, body, "gwasup.terminal.register"));
  }
  // 직원 입장 링크 새로 만들기 = 단말 키 새로 발급(예전 링크는 바로 끊김). 단말이 이 이벤트 것인지는 v2 가 확인한다.
  if (method === "POST" && path[0] === "onsite" && path[1] === "terminals" && path[3] === "key" && path.length === 4 && UUID_RE.test(path[2])) {
    return successResponse(await v2Write("POST", `/internal/events/${eventId}/terminals/${path[2]}/key`, body, "gwasup.terminal.rekey"));
  }
  if (method === "PATCH" && path[0] === "onsite" && path[1] === "terminals" && path.length === 3 && UUID_RE.test(path[2])) {
    return successResponse(await v2Write("PATCH", `/internal/events/${eventId}/terminals/${path[2]}`, body, "gwasup.terminal.update"));
  }
  if (method === "POST" && key === "onsite/blocks") {
    return successResponse(await v2Write("POST", `/internal/events/${eventId}/admission-blocks`, body, "gwasup.admission.block"));
  }
  if (method === "POST" && key === "sanctions") {
    return successResponse(await v2Write("POST", `/internal/events/${eventId}/sanctions`, body, "gwasup.sanction.impose"));
  }
  if (method === "POST" && path[0] === "sanctions" && path[2] === "lift" && path.length === 3 && UUID_RE.test(path[1])) {
    return successResponse(await v2Write("POST", `/internal/sanctions/${path[1]}/lift`, { ...body, eventId }, "gwasup.sanction.lift"));
  }
  if (method === "PUT" && key === "settlement") {
    return successResponse(await v2Write("PUT", `/internal/events/${eventId}/settlement`, body, "gwasup.settlement.mode"));
  }
  if (method === "POST" && key === "settlement/pg-accounts") {
    return successResponse(await v2Write("POST", `/internal/organizers/${organizerId}/pg-accounts`, body, "gwasup.pg-account.register"));
  }
  if (method === "POST" && path[0] === "settlement" && path[1] === "pg-accounts" && path[3] === "verify" && path.length === 4) {
    const overview = await v2Get<SettlementOverview>(`/internal/events/${eventId}/settlement`);
    if (!overview.accounts.some((a) => a.id === path[2])) return errorResponse("이 주최사의 PG 계정이 아닙니다", 404);
    return successResponse(await v2Write("POST", `/internal/pg-accounts/${path[2]}/verify`, body, "gwasup.pg-account.verify", 20_000));
  }
  return errorResponse("지원하지 않는 요청입니다", 404);
}

function route(method: "GET" | "POST" | "PUT" | "PATCH") {
  return withRole<Params>("organizer", async (request, { session, params }) => {
    let organizerId: string;
    try {
      const owned = await getOwnedEvent(params.eventId, session.accountId);
      if (!owned) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      organizerId = owned.organizer_id;
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", eventAccessStatus(err));
      }
      throw err;
    }
    const ctx: Ctx = {
      eventId: params.eventId,
      path: params.path ?? [],
      organizerId,
      actor: actorOf(session),
      request,
    };
    try {
      return method === "GET" ? await handleGet(ctx) : await handleWrite(method, ctx);
    } catch (err: unknown) {
      if (err instanceof V2GwasupError) {
        const status = err.status >= 400 && err.status < 600 ? err.status : 502;
        return errorResponse(err.message, status === 500 ? 502 : status);
      }
      logger.error("gwasup proxy 오류", { path: ctx.path.join("/"), err: err instanceof Error ? err.message : String(err) });
      return errorResponse("요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
  });
}

function actorOf(session: User): string {
  return (session.email || session.accountId || "organizer").slice(0, 64);
}

export const GET = route("GET");
export const POST = route("POST");
export const PUT = route("PUT");
export const PATCH = route("PATCH");

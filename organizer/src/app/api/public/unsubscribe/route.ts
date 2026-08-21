/**
 * 공개 수신거부(unsubscribe) — 광고성 메일/문자의 무료 수신거부(정보통신망법).
 * M-11: GET 은 처리하지 않고 확인 페이지만 반환한다(메일 보안 스캐너의 링크 prefetch 로 인한
 * 오수신거부 방지). 실제 억제는 POST(확인 버튼)에서 수행한다. 인증 불요(공개, 서명 토큰으로 검증).
 * 수신거부는 '마케팅 거부'로 기록되어 거래(예매·환불) 알림은 계속 발송된다(compliance canSendInfo).
 */
import { verifyUnsubscribeToken, suppress, withdrawConsent } from "@/lib/notification/compliance";
import { logger } from "@/lib/logger";

function page(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · PICKKET</title>
<style>
  body{margin:0;font-family:-apple-system,'Pretendard',sans-serif;background:#FAFBFF;color:#1A1D2E;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #eef;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.05);
        max-width:420px;width:100%;padding:40px 28px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#666;line-height:1.7;font-size:14px;margin:0}
  .logo{font-weight:800;letter-spacing:-.03em;color:#6C5CE7;margin-bottom:20px;font-size:18px}
</style></head>
<body><div class="card"><div class="logo">PICKKET</div><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function confirmPage(token: string): Response {
  // GET: 확인 버튼(POST) 페이지 — 스캐너 prefetch 로는 억제되지 않는다.
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>수신거부 확인 · PICKKET</title>
<style>
  body{margin:0;font-family:-apple-system,'Pretendard',sans-serif;background:#FAFBFF;color:#1A1D2E;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #eef;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.05);
        max-width:420px;width:100%;padding:40px 28px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#666;line-height:1.7;font-size:14px;margin:0 0 20px}
  .logo{font-weight:800;letter-spacing:-.03em;color:#6C5CE7;margin-bottom:20px;font-size:18px}
  button{background:#6C5CE7;color:#fff;border:0;border-radius:100px;padding:12px 28px;font-size:14px;
         font-weight:700;cursor:pointer}
</style></head>
<body><div class="card"><div class="logo">PICKKET</div>
<h1>광고성 메시지 수신을 거부하시겠어요?</h1>
<p>확인을 누르면 앞으로 광고성 메시지를 보내지 않습니다.<br/>예매·환불 등 거래 관련 필수 안내는 계속 발송됩니다.</p>
<form method="POST">
  <input type="hidden" name="token" value="${token.replace(/"/g, "")}"/>
  <button type="submit">수신거부 확인</button>
</form>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  // M-11: GET 은 억제하지 않는다 — 토큰만 검증하고 확인 페이지 반환. 채널은 토큰 서명에 포함(2.6-Low5).
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) {
    return page("링크가 유효하지 않습니다", "만료되었거나 잘못된 수신거부 링크입니다. 문의는 고객센터로 부탁드립니다.", 400);
  }
  return confirmPage(token);
}

export async function POST(request: Request) {
  // 확인 버튼 제출(form-urlencoded) 또는 JSON 모두 수용.
  let token = "";
  const ctype = request.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      const b = (await request.json()) as { token?: string };
      token = b.token ?? "";
    } else {
      const form = await request.formData();
      token = String(form.get("token") ?? "");
    }
  } catch {
    return page("처리 중 오류", "잘못된 요청입니다.", 400);
  }

  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) {
    return page("링크가 유효하지 않습니다", "만료되었거나 잘못된 수신거부 링크입니다. 문의는 고객센터로 부탁드립니다.", 400);
  }
  // 2.6-Low5: 채널은 토큰 서명값 사용(위조·재사용 불가).
  const channel = parsed.channel;

  try {
    await suppress(parsed.accountId, channel, parsed.contact, "unsubscribe");
    // §3-2: 수신거부는 동의 철회와 연동 — 동의 이력에 withdraw 기록.
    await withdrawConsent(parsed.accountId, channel, parsed.contact, "unsubscribe");
    logger.info("수신거부 처리", { channel, account: parsed.accountId });
  } catch (err) {
    logger.error("수신거부 처리 실패", { error: err instanceof Error ? err.message : "unknown" });
    return page("처리 중 오류", "잠시 후 다시 시도해주세요.", 500);
  }

  return page(
    "수신거부가 완료되었습니다",
    "앞으로 광고성 메시지를 보내지 않습니다. 예매·환불 등 거래 관련 필수 안내는 계속 발송될 수 있습니다.",
    200,
  );
}

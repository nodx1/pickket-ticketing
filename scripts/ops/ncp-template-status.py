#!/usr/bin/env python3
"""NCP SENS 알림톡 템플릿 심사상태 조회 (스크린샷 없이 CLI로 확인).

키 소스: CapRover(pickket-organizer 앱 env)의 NCP_ACCESS_KEY/SECRET_KEY. 키값은 절대 출력 안 함.
사용: CAPROVER_PW='...' python3 scripts/ops/ncp-template-status.py
판정: templateStatus == 'REGISTER'(또는 non-NOT_REGISTER) = 발송가능. 그 외 = 심사대기/미승인.
"""
import json, urllib.request, urllib.error, urllib.parse, hmac, hashlib, base64, time, os, ssl, sys

CAP = os.environ.get("CAPROVER_URL", "http://192.168.0.9:3000")
SECRETS = os.path.expanduser("~/Desktop/pickket-caprover-secrets.env")
SERVICE_ID = "ncp:kkobizmsg:kr:374145754908:pickket"
CHANNEL_ID = "@pickket"
TEMPLATE_CODE = os.environ.get("TEMPLATE_CODE", "PICKKETINVITE001")
SENS = "https://sens.apigw.ntruss.com"


def http(method, url, headers=None, data=None, timeout=15):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return None, f"ERR:{type(e).__name__}:{e}"


def caprover_password():
    pw = os.environ.get("CAPROVER_PW")
    if pw:
        return pw
    try:
        for line in open(SECRETS):
            if line.startswith("CAPROVER_PASSWORD="):
                v = line.split("=", 1)[1].strip()
                if v and not v.startswith("여기"):  # 플레이스홀더 방지
                    return v
    except FileNotFoundError:
        pass
    return None


def main():
    pw = caprover_password()
    if not pw:
        print("❌ CapRover 비번 없음 — CAPROVER_PW 환경변수로 전달하세요 (시크릿파일 값은 플레이스홀더)")
        sys.exit(1)

    st, body = http("POST", f"{CAP}/api/v2/login",
                    {"Content-Type": "application/json", "x-namespace": "captain"},
                    json.dumps({"password": pw}).encode())
    j = json.loads(body) if st == 200 else {}
    if j.get("status") != 100:
        print(f"❌ CapRover 로그인 실패: {j.get('description', body[:120])}")
        sys.exit(1)
    token = j["data"]["token"]

    st, body = http("GET", f"{CAP}/api/v2/user/apps/appDefinitions",
                    {"x-namespace": "captain", "x-captain-auth": token})
    apps = json.loads(body)["data"]["appDefinitions"]
    env = {e["key"]: e["value"] for a in apps if a.get("appName") == "pickket-organizer"
           for e in a.get("envVars", [])}
    ak, sk = env.get("NCP_ACCESS_KEY"), env.get("NCP_SECRET_KEY")
    if not ak or not sk:
        print("❌ organizer 앱 env에 NCP 키 없음")
        sys.exit(1)
    print("D단계 배선 여부 → organizer env:",
          "SERVICE_ID", "OK" if env.get("SENS_ALIMTALK_SERVICE_ID") else "미배선",
          "| CHANNEL_ID", "OK" if env.get("SENS_ALIMTALK_CHANNEL_ID") else "미배선")

    uri = (f"/alimtalk/v2/services/{SERVICE_ID}/templates"
           f"?channelId={urllib.parse.quote(CHANNEL_ID, safe=chr(0))}&templateCode={TEMPLATE_CODE}")
    ts = str(int(time.time() * 1000))
    sig = base64.b64encode(hmac.new(sk.encode(), f"GET {uri}\n{ts}\n{ak}".encode(),
                                    hashlib.sha256).digest()).decode()
    st, body = http("GET", f"{SENS}{uri}", {
        "Content-Type": "application/json", "x-ncp-apigw-timestamp": ts,
        "x-ncp-iam-access-key": ak, "x-ncp-apigw-signature-v2": sig})
    if st != 200:
        print(f"❌ NCP 템플릿 조회 실패 (status={st}): {body[:200]}")
        sys.exit(1)
    data = json.loads(body)
    tpls = data if isinstance(data, list) else data.get("templates") or data.get("data") or [data]
    if not tpls:
        print("템플릿 없음"); sys.exit(0)
    t = tpls[0]
    insp = t.get("templateInspectionStatus")
    tstat = t.get("templateStatus")
    # 실증(2026-07-21): INSPECT=검수중이면 발송 시 3015(템플릿 못 찾음)로 실패 = 미승인.
    # templateStatus=READY 는 "등록완료"일 뿐 승인 아님. 승인 신호 = inspectionStatus가 INSPECT를 벗어남.
    # enum 추측 반복 실패했으므로 최종 확정은 "실제 테스트 발송 성공"으로만 판정.
    pending_insp = {"ACCEPT", "INSPECT", "REG", "REQ"}
    usable = insp not in pending_insp
    if insp == "INSPECT":
        verdict = "⏳ 검수중(INSPECT) — 미승인, 발송 시 3015 실패. 승인 대기."
    elif usable:
        verdict = f"✅ 승인 가능성(inspectionStatus={insp}) — 반드시 테스트 발송으로 최종확인"
    else:
        verdict = f"⏳ 미승인 (inspectionStatus={insp}, templateStatus={tstat})"
    print(f"\n=== {t.get('templateCode')} ({t.get('templateName')}) ===")
    print(f"  templateInspectionStatus = {insp}")
    print(f"  templateStatus           = {tstat}")
    print(f"  카테고리                 = {t.get('categoryName')}")
    comments = t.get("comments") or []
    if comments:
        print(f"  ⚠️ 심사코멘트/반려사유    = {comments}")
    print(f"\n판정: {verdict}")
    # 본문이 코드와 일치하는지 눈으로 확인용(민감정보 아님)
    print(f"\n등록 본문:\n{t.get('content')}")


if __name__ == "__main__":
    main()

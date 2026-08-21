/**
 * 통합테스트 부트스트랩 — 실 PG 가 없으면 **즉시 실패**한다.
 *
 * 조용한 skip 을 두지 않는 이유: T8 의 출발점이 "테스트는 초록인데 prod 는 깨져 있었다" 이다.
 * 환경이 없어서 안 돈 것을 통과로 읽으면 같은 공백이 그대로 재발한다.
 */
if (process.env.PICKKET_ITEST !== "1") {
  throw new Error(
    "통합테스트 환경이 설정되지 않았습니다.\n" +
      '  bash scripts/itest-db.sh up && eval "$(bash scripts/itest-db.sh env)" && npm run test:integration',
  );
}
for (const key of ["PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD", "PG_DATABASE"]) {
  if (!process.env[key]) throw new Error(`통합테스트 DB 환경변수 누락: ${key}`);
}
if (!/itest/.test(process.env.PG_DATABASE ?? "")) {
  // prod/dev DB 오폭 방지 — 이 테스트는 TRUNCATE 를 돌린다.
  throw new Error(`안전장치: PG_DATABASE 이름에 'itest' 가 있어야 합니다 (현재: ${process.env.PG_DATABASE})`);
}

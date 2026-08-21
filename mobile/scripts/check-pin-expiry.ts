/**
 * CI 스크립트: SSL 핀 만료일 체크
 * 90일 이내면 경고, 30일 이내면 빌드 실패
 *
 * Usage: npx tsx scripts/check-pin-expiry.ts
 */

const PIN_EXPIRATION_DATE = "2027-04-13";
const WARN_DAYS = 90;
const FAIL_DAYS = 30;

const expiry = new Date(PIN_EXPIRATION_DATE);
const days = Math.floor((expiry.getTime() - Date.now()) / 86400000);

if (days < FAIL_DAYS) {
  console.error(`FAIL: SSL pins expire in ${days} days (< ${FAIL_DAYS}). Rotate pins NOW.`);
  process.exit(1);
} else if (days < WARN_DAYS) {
  console.warn(`WARN: SSL pins expire in ${days} days (< ${WARN_DAYS}). Plan pin rotation.`);
} else {
  console.log(`OK: SSL pins expire in ${days} days.`);
}

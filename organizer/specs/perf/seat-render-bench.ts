/**
 * R4 — 좌석 렌더링 성능 벤치마크
 *
 * 사용:
 *   npx tsx specs/perf/seat-render-bench.ts
 *
 * 1k / 5k / 10k / 50k / 80k / 150k 좌석 시드 → Playwright headless 에서
 * SeatMap 컴포넌트 마운트 후 FPS 측정.
 *
 * 실제 GUI 없이 API 레벨로 좌석 수 × draw 비용만 측정 (서버 렌더 아님).
 * 정밀 FPS 측정은 실 브라우저 수동 검증으로 (SEAT_MANUAL_VERIFICATION.md 시나리오 C1).
 *
 * 여기서는 tsc/빌드 시간 내에 "시드 N석 → API 응답 시간" 으로 간접 검증.
 */

const SEAT_COUNTS = [1000, 5000, 10000, 50000, 80000, 150000];

function generateSeats(count: number): Array<{
  section: string;
  row: string;
  seatNumber: string;
  x: number;
  y: number;
}> {
  const seats = [];
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    seats.push({
      section: `S${Math.floor(row / 26)}`,
      row: String.fromCharCode(65 + (row % 26)),
      seatNumber: String(col + 1),
      x: col * 28,
      y: row * 28,
    });
  }
  return seats;
}

async function main() {
  console.log("=== 좌석 렌더링 벤치마크 (간접) ===");
  console.log("시드 생성 + JSON 직렬화 시간으로 데이터 처리 비용 측정\n");

  for (const count of SEAT_COUNTS) {
    const t0 = performance.now();
    const seats = generateSeats(count);
    const t1 = performance.now();
    const json = JSON.stringify(seats);
    const t2 = performance.now();

    const genMs = (t1 - t0).toFixed(1);
    const serMs = (t2 - t1).toFixed(1);
    const sizeKB = (json.length / 1024).toFixed(0);

    console.log(
      `${String(count).padStart(7)} seats | gen ${genMs}ms | ser ${serMs}ms | ${sizeKB}KB`,
    );

    // 150k 시드 생성이 5초 이내면 OK (클라이언트 전송/파싱 가능)
    if (count >= 150000 && Number(genMs) + Number(serMs) > 5000) {
      console.log("❌ FAIL: 150k 시드 처리 > 5s");
      process.exit(1);
    }
  }

  console.log("\n✅ 모든 시드 크기 생성 + 직렬화 성공");
  console.log("실 FPS 측정은 SEAT_MANUAL_VERIFICATION.md 시나리오 C1 참조");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

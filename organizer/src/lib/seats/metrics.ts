/**
 * 좌석 시스템 메트릭 — Phase 10 (P0-O4)
 *
 * `/api/metrics` 엔드포인트에서 노출할 수 있는 단순 인메모리 카운터.
 * 프로세스 재시작 시 초기화되므로 Prometheus 같은 외부 시계열 저장소가
 * 필요하면 추후 교체해야 한다.
 */

interface SeatMetricsSnapshot {
  holdTotal: number;
  holdFailures: number;
  verifyAndMarkSoldTotal: number;
  verifyAndMarkSoldFailures: number;
  reaperProcessed: number;
  sseActiveConnections: number;
  bestAvailableTotal: number;
  bestAvailableFailures: number;
  // 트랙 7.22 — 신규 메트릭
  companionTotal: number;
  companionFailures: number;
  watchTotal: number;
  funnelEventsTotal: number;
  printPdfTotal: number;
  dxfImportTotal: number;
  svgImportTotal: number;
}

class SeatMetrics implements SeatMetricsSnapshot {
  holdTotal = 0;
  holdFailures = 0;
  verifyAndMarkSoldTotal = 0;
  verifyAndMarkSoldFailures = 0;
  reaperProcessed = 0;
  sseActiveConnections = 0;
  bestAvailableTotal = 0;
  bestAvailableFailures = 0;
  // 트랙 7.22 — 신규
  companionTotal = 0;
  companionFailures = 0;
  watchTotal = 0;
  funnelEventsTotal = 0;
  printPdfTotal = 0;
  dxfImportTotal = 0;
  svgImportTotal = 0;

  incrementHold(success: boolean) {
    this.holdTotal += 1;
    if (!success) this.holdFailures += 1;
  }

  incrementVerifyAndMarkSold(success: boolean) {
    this.verifyAndMarkSoldTotal += 1;
    if (!success) this.verifyAndMarkSoldFailures += 1;
  }

  incrementBestAvailable(success: boolean) {
    this.bestAvailableTotal += 1;
    if (!success) this.bestAvailableFailures += 1;
  }

  incrementCompanion(success: boolean) {
    this.companionTotal += 1;
    if (!success) this.companionFailures += 1;
  }

  incrementWatch() {
    this.watchTotal += 1;
  }

  incrementFunnelEvent() {
    this.funnelEventsTotal += 1;
  }

  incrementPrintPdf() {
    this.printPdfTotal += 1;
  }

  incrementImport(format: "dxf" | "svg") {
    if (format === "dxf") this.dxfImportTotal += 1;
    else this.svgImportTotal += 1;
  }

  incrementReaper(processed: number) {
    this.reaperProcessed += processed;
  }

  sseConnected() {
    this.sseActiveConnections += 1;
  }

  sseDisconnected() {
    this.sseActiveConnections = Math.max(0, this.sseActiveConnections - 1);
  }

  snapshot(): SeatMetricsSnapshot {
    return {
      holdTotal: this.holdTotal,
      holdFailures: this.holdFailures,
      verifyAndMarkSoldTotal: this.verifyAndMarkSoldTotal,
      verifyAndMarkSoldFailures: this.verifyAndMarkSoldFailures,
      reaperProcessed: this.reaperProcessed,
      sseActiveConnections: this.sseActiveConnections,
      bestAvailableTotal: this.bestAvailableTotal,
      bestAvailableFailures: this.bestAvailableFailures,
      companionTotal: this.companionTotal,
      companionFailures: this.companionFailures,
      watchTotal: this.watchTotal,
      funnelEventsTotal: this.funnelEventsTotal,
      printPdfTotal: this.printPdfTotal,
      dxfImportTotal: this.dxfImportTotal,
      svgImportTotal: this.svgImportTotal,
    };
  }

  reset() {
    this.holdTotal = 0;
    this.holdFailures = 0;
    this.verifyAndMarkSoldTotal = 0;
    this.verifyAndMarkSoldFailures = 0;
    this.reaperProcessed = 0;
    this.sseActiveConnections = 0;
    this.bestAvailableTotal = 0;
    this.bestAvailableFailures = 0;
    this.companionTotal = 0;
    this.companionFailures = 0;
    this.watchTotal = 0;
    this.funnelEventsTotal = 0;
    this.printPdfTotal = 0;
    this.dxfImportTotal = 0;
    this.svgImportTotal = 0;
  }
}

export const seatMetrics = new SeatMetrics();
export type { SeatMetricsSnapshot };

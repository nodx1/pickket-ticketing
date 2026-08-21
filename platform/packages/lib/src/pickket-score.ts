/**
 * Pickket Score — deal quality rating (0-100)
 */

export interface PickketScoreInput {
  currentAskPrice: number | null;
  facePrice: number;
  priceChangePct: number;
  eventDate: string | null;
  totalListings: number;
  totalBuyOrders: number;
}

export interface PickketScoreResult {
  score: number;
  label: string;
  color: string;
  bgColor: string;
  description: string;
  descriptionParams?: Record<string, string | number>;
}

function calcPriceRatioScore(askPrice: number | null, facePrice: number): number {
  if (askPrice === null || facePrice <= 0) return 25;
  const ratio = (askPrice - facePrice) / facePrice;
  return Math.max(0, Math.min(50, 50 * (1 - ratio)));
}

function calcTrendScore(priceChangePct: number): number {
  if (priceChangePct <= -5) return 20;
  if (priceChangePct >= 5) return 0;
  return 20 * (1 - (priceChangePct + 5) / 10);
}

function calcTimeScore(eventDate: string | null): number {
  if (!eventDate) return 10;
  const now = new Date();
  const event = new Date(eventDate);
  const daysUntil = (event.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysUntil > 30) return 15;
  if (daysUntil >= 7) return 10;
  if (daysUntil >= 1) return 5;
  return 0;
}

function calcDepthScore(totalListings: number): number {
  return Math.min(15, totalListings * 1.5);
}

function getScoreMeta(
  score: number,
  askPrice: number | null,
  facePrice: number
): Omit<PickketScoreResult, "score"> {
  const priceDiffPct =
    askPrice !== null && facePrice > 0
      ? Math.round(((askPrice - facePrice) / facePrice) * 100)
      : null;

  let description: string;
  let descriptionParams: Record<string, string | number> | undefined;

  if (priceDiffPct !== null) {
    if (priceDiffPct === 0) {
      description = "sameFace";
    } else if (priceDiffPct > 0) {
      description = "aboveFace";
      descriptionParams = { pct: priceDiffPct };
    } else {
      description = "belowFacePrice";
      descriptionParams = { pct: priceDiffPct };
    }
  } else {
    description = "noPrice";
  }

  if (score >= 90) return { label: "optimalPrice", color: "text-emerald-500", bgColor: "bg-emerald-50", description, descriptionParams };
  if (score >= 70) return { label: "goodPrice", color: "text-lime-500", bgColor: "bg-lime-50", description, descriptionParams };
  if (score >= 50) return { label: "averagePrice", color: "text-amber-500", bgColor: "bg-amber-50", description, descriptionParams };
  if (score >= 30) return { label: "highPrice", color: "text-orange-500", bgColor: "bg-orange-50", description, descriptionParams };
  return { label: "veryHighPrice", color: "text-red-500", bgColor: "bg-red-50", description, descriptionParams };
}

export function calculatePickketScore(input: PickketScoreInput): PickketScoreResult {
  const priceRatio = calcPriceRatioScore(input.currentAskPrice, input.facePrice);
  const trend = calcTrendScore(input.priceChangePct);
  const time = calcTimeScore(input.eventDate);
  const depth = calcDepthScore(input.totalListings);
  const rawScore = priceRatio + trend + time + depth;
  const score = Math.round(Math.max(0, Math.min(100, rawScore)));
  return { score, ...getScoreMeta(score, input.currentAskPrice, input.facePrice) };
}

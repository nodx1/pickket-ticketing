import { describe, it, expect } from "vitest";
import { calculatePickketScore, PickketScoreInput } from "../pickket-score";

function makeInput(overrides: Partial<PickketScoreInput> = {}): PickketScoreInput {
  return {
    currentAskPrice: 100000,
    facePrice: 100000,
    priceChangePct: 0,
    eventDate: null,
    totalListings: 5,
    totalBuyOrders: 3,
    ...overrides,
  };
}

describe("calculatePickketScore", () => {
  describe("score range", () => {
    it("returns a score between 0 and 100", () => {
      const result = calculatePickketScore(makeInput());
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("returns an integer score", () => {
      const result = calculatePickketScore(makeInput());
      expect(Number.isInteger(result.score)).toBe(true);
    });
  });

  describe("result shape", () => {
    it("returns all required fields", () => {
      const result = calculatePickketScore(makeInput());
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("label");
      expect(result).toHaveProperty("color");
      expect(result).toHaveProperty("bgColor");
      expect(result).toHaveProperty("description");
    });
  });

  describe("price ratio component", () => {
    it("gives highest price score when ask equals face price", () => {
      const atFace = calculatePickketScore(
        makeInput({ currentAskPrice: 100000, facePrice: 100000 })
      );
      const aboveFace = calculatePickketScore(
        makeInput({ currentAskPrice: 150000, facePrice: 100000 })
      );
      expect(atFace.score).toBeGreaterThan(aboveFace.score);
    });

    it("gives lower score when ask is much higher than face", () => {
      const result = calculatePickketScore(
        makeInput({ currentAskPrice: 200000, facePrice: 100000 })
      );
      // At 2x face price, price ratio score should be 0
      // Total score should be lower than midpoint
      expect(result.score).toBeLessThan(50);
    });

    it("gives neutral price score when ask price is null", () => {
      const withNull = calculatePickketScore(
        makeInput({ currentAskPrice: null })
      );
      // Should return 25 for neutral price ratio
      expect(withNull.score).toBeGreaterThan(0);
    });

    it("gives below-face bonus (ask below face value)", () => {
      const belowFace = calculatePickketScore(
        makeInput({ currentAskPrice: 80000, facePrice: 100000 })
      );
      const atFace = calculatePickketScore(
        makeInput({ currentAskPrice: 100000, facePrice: 100000 })
      );
      // Below face price should have higher price ratio (capped at 50)
      expect(belowFace.score).toBeGreaterThanOrEqual(atFace.score);
    });
  });

  describe("trend component", () => {
    it("rewards dropping prices", () => {
      const dropping = calculatePickketScore(
        makeInput({ priceChangePct: -5 })
      );
      const rising = calculatePickketScore(
        makeInput({ priceChangePct: 5 })
      );
      expect(dropping.score).toBeGreaterThan(rising.score);
    });

    it("gives maximum trend score at -5% or below", () => {
      const minus5 = calculatePickketScore(
        makeInput({ priceChangePct: -5 })
      );
      const minus10 = calculatePickketScore(
        makeInput({ priceChangePct: -10 })
      );
      // Both should get full 20 trend points, so same total score
      expect(minus5.score).toBe(minus10.score);
    });

    it("gives zero trend score at +5% or above", () => {
      const plus5 = calculatePickketScore(
        makeInput({ priceChangePct: 5 })
      );
      const plus10 = calculatePickketScore(
        makeInput({ priceChangePct: 10 })
      );
      // Both should get 0 trend points, so same total score
      expect(plus5.score).toBe(plus10.score);
    });
  });

  describe("time component", () => {
    it("gives neutral score when event date is null", () => {
      const result = calculatePickketScore(makeInput({ eventDate: null }));
      // With null event date, time score is 10 (neutral)
      expect(result.score).toBeGreaterThan(0);
    });

    it("gives higher score for distant events", () => {
      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 60);
      const nearFuture = new Date();
      nearFuture.setDate(nearFuture.getDate() + 2);

      const farResult = calculatePickketScore(
        makeInput({ eventDate: farFuture.toISOString() })
      );
      const nearResult = calculatePickketScore(
        makeInput({ eventDate: nearFuture.toISOString() })
      );
      expect(farResult.score).toBeGreaterThan(nearResult.score);
    });

    it("gives zero time score for past events", () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 60);

      const pastResult = calculatePickketScore(
        makeInput({ eventDate: pastDate.toISOString() })
      );
      const futureResult = calculatePickketScore(
        makeInput({ eventDate: farFuture.toISOString() })
      );
      expect(pastResult.score).toBeLessThan(futureResult.score);
    });
  });

  describe("market depth component", () => {
    it("gives higher score with more listings", () => {
      const manyListings = calculatePickketScore(
        makeInput({ totalListings: 20 })
      );
      const fewListings = calculatePickketScore(
        makeInput({ totalListings: 1 })
      );
      expect(manyListings.score).toBeGreaterThan(fewListings.score);
    });

    it("caps depth score at 15 points (10 listings)", () => {
      const at10 = calculatePickketScore(makeInput({ totalListings: 10 }));
      const at20 = calculatePickketScore(makeInput({ totalListings: 20 }));
      // Both should hit the 15-point cap, so same score
      expect(at10.score).toBe(at20.score);
    });
  });

  describe("score labels", () => {
    it("labels score >= 90 as optimalPrice", () => {
      // Max scenario: at face price (50), trend -5 (20), >30 days (15), 10+ listings (15) = 100
      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 60);
      const result = calculatePickketScore({
        currentAskPrice: 100000,
        facePrice: 100000,
        priceChangePct: -5,
        eventDate: farFuture.toISOString(),
        totalListings: 10,
        totalBuyOrders: 0,
      });
      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.label).toBe("optimalPrice");
      expect(result.color).toContain("emerald");
    });

    it("labels low score as veryHighPrice", () => {
      // Worst scenario: 2x face (0), +10% trend (0), past event (0), 0 listings (0) = 0
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const result = calculatePickketScore({
        currentAskPrice: 200000,
        facePrice: 100000,
        priceChangePct: 10,
        eventDate: pastDate.toISOString(),
        totalListings: 0,
        totalBuyOrders: 0,
      });
      expect(result.score).toBeLessThan(30);
      expect(result.label).toBe("veryHighPrice");
      expect(result.color).toContain("red");
    });
  });

  describe("description field", () => {
    it("returns sameFace token when ask equals face", () => {
      const result = calculatePickketScore(
        makeInput({ currentAskPrice: 100000, facePrice: 100000 })
      );
      expect(result.description).toBe("sameFace");
      expect(result.descriptionParams).toBeUndefined();
    });

    it("returns aboveFace token with pct param when ask above face", () => {
      const result = calculatePickketScore(
        makeInput({ currentAskPrice: 150000, facePrice: 100000 })
      );
      expect(result.description).toBe("aboveFace");
      expect(result.descriptionParams).toEqual({ pct: 50 });
    });

    it("returns belowFacePrice token with pct param when ask below face", () => {
      const result = calculatePickketScore(
        makeInput({ currentAskPrice: 80000, facePrice: 100000 })
      );
      expect(result.description).toBe("belowFacePrice");
      expect(result.descriptionParams).toEqual({ pct: -20 });
    });

    it("returns noPrice token when ask is null", () => {
      const result = calculatePickketScore(makeInput({ currentAskPrice: null }));
      expect(result.description).toBe("noPrice");
      expect(result.descriptionParams).toBeUndefined();
    });
  });
});

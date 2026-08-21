import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  SUB_CATEGORIES,
  CITIES,
  SORT_OPTIONS,
  DEMAND_LEVELS,
  AGE_RESTRICTIONS,
  getCategoryBySlug,
  getDemandLevel,
  EFFECTIVE_DATE,
} from "../constants";

describe("CATEGORIES", () => {
  it("has 8 category entries", () => {
    expect(CATEGORIES.length).toBe(8);
  });

  it("each category has slug, label, labelEn, icon, color", () => {
    for (const cat of CATEGORIES) {
      expect(cat.slug).toBeDefined();
      expect(typeof cat.slug).toBe("string");
      expect(cat.label).toBeDefined();
      expect(cat.labelEn).toBeDefined();
      expect(cat.icon).toBeDefined();
      expect(cat.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("has unique slugs", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("includes all expected categories", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(slugs).toContain("concert");
    expect(slugs).toContain("musical");
    expect(slugs).toContain("sports");
    expect(slugs).toContain("classical");
    expect(slugs).toContain("exhibition");
    expect(slugs).toContain("festival");
    expect(slugs).toContain("education");
    expect(slugs).toContain("civic");
  });
});

describe("SUB_CATEGORIES", () => {
  it("has entries for all category slugs", () => {
    for (const cat of CATEGORIES) {
      expect(SUB_CATEGORIES[cat.slug]).toBeDefined();
      expect(Array.isArray(SUB_CATEGORIES[cat.slug])).toBe(true);
      expect(SUB_CATEGORIES[cat.slug].length).toBeGreaterThan(0);
    }
  });

  it("concert sub-categories include K-POP", () => {
    expect(SUB_CATEGORIES.concert).toContain("K-POP");
  });

  it("sports sub-categories include e-sports", () => {
    expect(SUB_CATEGORIES.sports).toContain("e스포츠");
  });
});

describe("CITIES", () => {
  it("has 13 city entries", () => {
    expect(CITIES.length).toBe(13);
  });

  it("includes major Korean cities", () => {
    expect(CITIES).toContain("서울");
    expect(CITIES).toContain("부산");
    expect(CITIES).toContain("제주");
  });
});

describe("SORT_OPTIONS", () => {
  it("has 5 sort options", () => {
    expect(SORT_OPTIONS.length).toBe(5);
  });

  it("each option has value and label", () => {
    for (const opt of SORT_OPTIONS) {
      expect(opt.value).toBeDefined();
      expect(opt.label).toBeDefined();
    }
  });

  it("includes popular and newest sorts", () => {
    const values = SORT_OPTIONS.map((o) => o.value);
    expect(values).toContain("popular");
    expect(values).toContain("newest");
    expect(values).toContain("date");
  });
});

describe("DEMAND_LEVELS", () => {
  it("has HIGH, MEDIUM, LOW, HIDDEN_GEM levels", () => {
    expect(DEMAND_LEVELS.HIGH).toBeDefined();
    expect(DEMAND_LEVELS.MEDIUM).toBeDefined();
    expect(DEMAND_LEVELS.LOW).toBeDefined();
    expect(DEMAND_LEVELS.HIDDEN_GEM).toBeDefined();
  });

  it("each level has label, color, textColor", () => {
    for (const level of Object.values(DEMAND_LEVELS)) {
      expect(level.label).toBeDefined();
      expect(level.color).toBeDefined();
      expect(level.textColor).toBeDefined();
    }
  });
});

describe("AGE_RESTRICTIONS", () => {
  it("has 4 age restriction options", () => {
    expect(AGE_RESTRICTIONS.length).toBe(4);
  });

  it("includes common age restrictions", () => {
    expect(AGE_RESTRICTIONS).toContain("전체");
    expect(AGE_RESTRICTIONS).toContain("19세 이상");
  });
});

describe("getCategoryBySlug", () => {
  it("returns category object for valid slug", () => {
    const cat = getCategoryBySlug("concert");
    expect(cat).toBeDefined();
    expect(cat?.slug).toBe("concert");
    expect(cat?.label).toBe("콘서트");
  });

  it("returns undefined for unknown slug", () => {
    expect(getCategoryBySlug("unknown")).toBeUndefined();
  });

  it("returns correct data for all slugs", () => {
    for (const expected of CATEGORIES) {
      const result = getCategoryBySlug(expected.slug);
      expect(result).toEqual(expected);
    }
  });
});

describe("getDemandLevel", () => {
  it("returns HIGH when ratio >= 2", () => {
    expect(getDemandLevel(200, 100)).toBe("HIGH");
    expect(getDemandLevel(300, 100)).toBe("HIGH");
  });

  it("returns MEDIUM when ratio >= 1 and < 2", () => {
    expect(getDemandLevel(100, 100)).toBe("MEDIUM");
    expect(getDemandLevel(150, 100)).toBe("MEDIUM");
  });

  it("returns LOW when ratio >= 0.3 (or bidCount is 0)", () => {
    expect(getDemandLevel(50, 100)).toBe("LOW");
    expect(getDemandLevel(0, 100)).toBe("LOW");
  });

  it("returns HIDDEN_GEM when ratio < 0.3 and bidCount > 0", () => {
    expect(getDemandLevel(10, 100)).toBe("HIDDEN_GEM");
    expect(getDemandLevel(5, 100)).toBe("HIDDEN_GEM");
  });

  it("handles totalSeats = 0 edge case", () => {
    // ratio = 0, bidCount > 0 => HIDDEN_GEM
    expect(getDemandLevel(10, 0)).toBe("HIDDEN_GEM");
    // ratio = 0, bidCount = 0 => LOW
    expect(getDemandLevel(0, 0)).toBe("LOW");
  });

  it("handles exact boundary at ratio = 2", () => {
    expect(getDemandLevel(200, 100)).toBe("HIGH");
  });

  it("handles exact boundary at ratio = 1", () => {
    expect(getDemandLevel(100, 100)).toBe("MEDIUM");
  });

  it("handles exact boundary at ratio = 0.3", () => {
    expect(getDemandLevel(30, 100)).toBe("LOW");
  });
});

describe("EFFECTIVE_DATE", () => {
  it("is a non-empty string", () => {
    expect(typeof EFFECTIVE_DATE).toBe("string");
    expect(EFFECTIVE_DATE.length).toBeGreaterThan(0);
  });
});

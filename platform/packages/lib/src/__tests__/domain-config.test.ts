import { describe, it, expect } from "vitest";
import {
  getDomainLabels,
  getOrganizerLabels,
  getFocalPointLabel,
  DOMAIN_LABELS,
  ORGANIZER_LABELS,
  type DomainLabels,
  type OrganizerLabels,
} from "../domain-config";

describe("DOMAIN_LABELS", () => {
  const expectedCategories = [
    "concert",
    "musical",
    "sports",
    "classical",
    "exhibition",
    "festival",
    "education",
    "civic",
  ];

  it("has entries for all 8 categories", () => {
    expect(Object.keys(DOMAIN_LABELS)).toEqual(
      expect.arrayContaining(expectedCategories),
    );
    expect(Object.keys(DOMAIN_LABELS).length).toBe(8);
  });

  it.each(expectedCategories)(
    "category '%s' has all required DomainLabels fields",
    (category) => {
      const labels = DOMAIN_LABELS[category];
      expect(labels).toBeDefined();
      expect(labels.subjectLabel).toBeDefined();
      expect(typeof labels.subjectLabel).toBe("string");
      expect(labels.communityLabel).toBeDefined();
      expect(labels.memberLabel).toBeDefined();
      expect(labels.tierLabels).toBeDefined();
      expect(labels.tierLabels.basic).toBeDefined();
      expect(labels.tierLabels.premium).toBeDefined();
      expect(labels.tierLabels.vip).toBeDefined();
      expect(labels.placeholderName).toBeDefined();
      expect(labels.placeholderCommunity).toBeDefined();
    },
  );

  it("concert labels are correct", () => {
    expect(DOMAIN_LABELS.concert.subjectLabel).toBe("아티스트");
    expect(DOMAIN_LABELS.concert.communityLabel).toBe("팬클럽");
    expect(DOMAIN_LABELS.concert.memberLabel).toBe("팬");
    expect(DOMAIN_LABELS.concert.tierLabels.basic).toBe("팬");
    expect(DOMAIN_LABELS.concert.tierLabels.premium).toBe("코어팬");
    expect(DOMAIN_LABELS.concert.tierLabels.vip).toBe("마스터팬");
  });

  it("sports labels use appropriate terminology", () => {
    expect(DOMAIN_LABELS.sports.subjectLabel).toBe("팀");
    expect(DOMAIN_LABELS.sports.communityLabel).toBe("서포터즈");
    expect(DOMAIN_LABELS.sports.memberLabel).toBe("서포터");
  });

  it("exhibition labels use appropriate terminology", () => {
    expect(DOMAIN_LABELS.exhibition.subjectLabel).toBe("작가");
    expect(DOMAIN_LABELS.exhibition.communityLabel).toBe("동호회");
  });
});

describe("getDomainLabels", () => {
  it("returns concert labels as default when no category provided", () => {
    const labels = getDomainLabels();
    expect(labels).toEqual(DOMAIN_LABELS.concert);
  });

  it("returns concert labels for null category", () => {
    const labels = getDomainLabels(null);
    expect(labels).toEqual(DOMAIN_LABELS.concert);
  });

  it("returns concert labels for undefined category", () => {
    const labels = getDomainLabels(undefined);
    expect(labels).toEqual(DOMAIN_LABELS.concert);
  });

  it("returns correct labels for each known category", () => {
    expect(getDomainLabels("concert")).toEqual(DOMAIN_LABELS.concert);
    expect(getDomainLabels("musical")).toEqual(DOMAIN_LABELS.musical);
    expect(getDomainLabels("sports")).toEqual(DOMAIN_LABELS.sports);
    expect(getDomainLabels("classical")).toEqual(DOMAIN_LABELS.classical);
    expect(getDomainLabels("exhibition")).toEqual(DOMAIN_LABELS.exhibition);
    expect(getDomainLabels("festival")).toEqual(DOMAIN_LABELS.festival);
    expect(getDomainLabels("education")).toEqual(DOMAIN_LABELS.education);
    expect(getDomainLabels("civic")).toEqual(DOMAIN_LABELS.civic);
  });

  it("handles case-insensitive category lookup", () => {
    expect(getDomainLabels("CONCERT")).toEqual(DOMAIN_LABELS.concert);
    expect(getDomainLabels("Concert")).toEqual(DOMAIN_LABELS.concert);
    expect(getDomainLabels("SPORTS")).toEqual(DOMAIN_LABELS.sports);
  });

  it("returns concert as fallback for unknown categories", () => {
    expect(getDomainLabels("unknown")).toEqual(DOMAIN_LABELS.concert);
    expect(getDomainLabels("gaming")).toEqual(DOMAIN_LABELS.concert);
  });
});

describe("ORGANIZER_LABELS", () => {
  const expectedCategories = [
    "concert",
    "musical",
    "sports",
    "classical",
    "exhibition",
    "festival",
    "education",
    "civic",
  ];

  it("has entries for all 8 categories", () => {
    expect(Object.keys(ORGANIZER_LABELS).length).toBe(8);
  });

  it.each(expectedCategories)(
    "category '%s' has all required OrganizerLabels fields",
    (category) => {
      const labels = ORGANIZER_LABELS[category];
      expect(labels).toBeDefined();
      expect(labels.eventLabel).toBeDefined();
      expect(labels.venueLabel).toBeDefined();
      expect(labels.sessionLabel).toBeDefined();
      expect(labels.descriptionLabel).toBeDefined();
      expect(labels.reviewLabel).toBeDefined();
      expect(labels.expectationLabel).toBeDefined();
      expect(labels.participantLabel).toBeDefined();
      expect(labels.participantEntryLabel).toBeDefined();
      expect(labels.ageRatingLabel).toBeDefined();
      expect(labels.durationLabel).toBeDefined();
      expect(labels.infoTabLabel).toBeDefined();
      expect(labels.distanceRefLabel).toBeDefined();
      expect(labels.verifyMessage).toBeDefined();
      expect(labels.bidPrompt).toBeDefined();
      expect(labels.sessionPickerLabel).toBeDefined();
      expect(labels.ctaVerb).toBeDefined();
      expect(labels.ticketNoun).toBeDefined();
    },
  );

  it("sports uses appropriate terminology", () => {
    const labels = ORGANIZER_LABELS.sports;
    expect(labels.eventLabel).toBe("경기");
    expect(labels.venueLabel).toBe("경기장");
    expect(labels.ticketNoun).toBe("티켓");
    expect(labels.ctaVerb).toBe("예매");
  });

  it("exhibition uses appropriate terminology", () => {
    const labels = ORGANIZER_LABELS.exhibition;
    expect(labels.eventLabel).toBe("전시");
    expect(labels.venueLabel).toBe("전시관");
    expect(labels.ticketNoun).toBe("티켓");
    expect(labels.ctaVerb).toBe("예매");
  });

  it("education uses appropriate terminology", () => {
    const labels = ORGANIZER_LABELS.education;
    expect(labels.eventLabel).toBe("강좌");
    expect(labels.ticketNoun).toBe("티켓");
    expect(labels.ctaVerb).toBe("예매");
  });
});

describe("getOrganizerLabels", () => {
  it("returns concert labels as default when no category provided", () => {
    const labels = getOrganizerLabels();
    expect(labels).toEqual(ORGANIZER_LABELS.concert);
  });

  it("returns concert labels for null/undefined", () => {
    expect(getOrganizerLabels(null)).toEqual(ORGANIZER_LABELS.concert);
    expect(getOrganizerLabels(undefined)).toEqual(ORGANIZER_LABELS.concert);
  });

  it("returns correct labels for each known category", () => {
    expect(getOrganizerLabels("sports")).toEqual(ORGANIZER_LABELS.sports);
    expect(getOrganizerLabels("festival")).toEqual(ORGANIZER_LABELS.festival);
  });

  it("handles case-insensitive lookup", () => {
    expect(getOrganizerLabels("CLASSICAL")).toEqual(ORGANIZER_LABELS.classical);
  });

  it("returns concert as fallback for unknown categories", () => {
    expect(getOrganizerLabels("unknown")).toEqual(ORGANIZER_LABELS.concert);
  });
});

describe("getFocalPointLabel", () => {
  it('returns "STAGE" for concert', () => {
    expect(getFocalPointLabel("concert")).toBe("STAGE");
  });

  it('returns "STAGE" for musical', () => {
    expect(getFocalPointLabel("musical")).toBe("STAGE");
  });

  it('returns "STAGE" for classical', () => {
    expect(getFocalPointLabel("classical")).toBe("STAGE");
  });

  it('returns "FIELD" for sports', () => {
    expect(getFocalPointLabel("sports")).toBe("FIELD");
  });

  it('returns "MAIN STAGE" for festival', () => {
    expect(getFocalPointLabel("festival")).toBe("MAIN STAGE");
  });

  it("returns null for exhibition (no focal point)", () => {
    expect(getFocalPointLabel("exhibition")).toBeNull();
  });

  it("returns null for education", () => {
    expect(getFocalPointLabel("education")).toBeNull();
  });

  it("returns null for civic", () => {
    expect(getFocalPointLabel("civic")).toBeNull();
  });

  it('returns "STAGE" as default for null/undefined', () => {
    expect(getFocalPointLabel(null)).toBe("STAGE");
    expect(getFocalPointLabel(undefined)).toBe("STAGE");
  });

  it('returns "STAGE" for unknown categories', () => {
    expect(getFocalPointLabel("unknown")).toBe("STAGE");
  });

  it("handles case-insensitive lookup", () => {
    expect(getFocalPointLabel("SPORTS")).toBe("FIELD");
    expect(getFocalPointLabel("Festival")).toBe("MAIN STAGE");
  });
});

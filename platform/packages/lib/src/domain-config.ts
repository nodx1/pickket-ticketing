/**
 * Domain-specific label configuration for multi-domain ticketing.
 * Maps event categories to appropriate community/member/tier labels.
 */

export interface DomainLabels {
  subjectLabel: string;
  communityLabel: string;
  memberLabel: string;
  tierLabels: { basic: string; premium: string; vip: string };
  placeholderName: string;
  placeholderCommunity: string;
}

export const DOMAIN_LABELS: Record<string, DomainLabels> = {
  concert: {
    subjectLabel: "아티스트",
    communityLabel: "팬클럽",
    memberLabel: "팬",
    tierLabels: { basic: "팬", premium: "코어팬", vip: "마스터팬" },
    placeholderName: "예: BTS",
    placeholderCommunity: "예: BTS ARMY",
  },
  musical: {
    subjectLabel: "작품",
    communityLabel: "서포터즈",
    memberLabel: "서포터",
    tierLabels: { basic: "서포터", premium: "골드", vip: "플래티넘" },
    placeholderName: "예: 레미제라블",
    placeholderCommunity: "예: 레미제라블 서포터즈",
  },
  sports: {
    subjectLabel: "팀",
    communityLabel: "서포터즈",
    memberLabel: "서포터",
    tierLabels: { basic: "서포터", premium: "시즌권", vip: "울트라" },
    placeholderName: "예: 삼성 라이온즈",
    placeholderCommunity: "예: 삼성 라이온즈 서포터즈",
  },
  classical: {
    subjectLabel: "연주자",
    communityLabel: "동호회",
    memberLabel: "후원자",
    tierLabels: { basic: "회원", premium: "정회원", vip: "후원회원" },
    placeholderName: "예: 서울시향",
    placeholderCommunity: "예: 서울시향 후원회",
  },
  exhibition: {
    subjectLabel: "작가",
    communityLabel: "동호회",
    memberLabel: "회원",
    tierLabels: { basic: "멤버", premium: "프리미엄", vip: "패트론" },
    placeholderName: "예: 이우환",
    placeholderCommunity: "예: 현대미술 동호회",
  },
  festival: {
    subjectLabel: "페스티벌",
    communityLabel: "크루",
    memberLabel: "크루원",
    tierLabels: { basic: "크루원", premium: "헤드크루", vip: "VIP" },
    placeholderName: "예: 자라섬 재즈",
    placeholderCommunity: "예: 자라섬 크루",
  },
  education: {
    subjectLabel: "강사",
    communityLabel: "학습자 그룹",
    memberLabel: "수강생",
    tierLabels: { basic: "수강생", premium: "우수수강생", vip: "마스터" },
    placeholderName: "예: 홍길동 강사",
    placeholderCommunity: "예: 파이썬 학습 모임",
  },
  civic: {
    subjectLabel: "주최기관",
    communityLabel: "시민 모임",
    memberLabel: "참여자",
    tierLabels: { basic: "참여자", premium: "활동회원", vip: "운영위원" },
    placeholderName: "예: 서울시 도시재생과",
    placeholderCommunity: "예: 우리동네 주민모임",
  },
};

export function getDomainLabels(category?: string | null): DomainLabels {
  if (!category) return DOMAIN_LABELS.concert;
  return DOMAIN_LABELS[category.toLowerCase()] ?? DOMAIN_LABELS.concert;
}

/**
 * Organizer-portal specific labels per domain.
 * Used throughout the organizer pages for domain-adaptive terminology.
 */
export interface OrganizerLabels {
  eventLabel: string;
  venueLabel: string;
  sessionLabel: string;
  descriptionLabel: string;
  reviewLabel: string;
  expectationLabel: string;
  participantLabel: string;
  participantEntryLabel: string;
  ageRatingLabel: string;
  durationLabel: string;
  infoTabLabel: string;
  distanceRefLabel: string;
  verifyMessage: string;
  bidPrompt: string;
  sessionPickerLabel: string;
  ctaVerb: string;
  ticketNoun: string;
}

export const ORGANIZER_LABELS: Record<string, OrganizerLabels> = {
  concert: {
    eventLabel: "공연",
    venueLabel: "공연장",
    sessionLabel: "회차",
    descriptionLabel: "공연설명",
    reviewLabel: "관람후기",
    expectationLabel: "기대평",
    participantLabel: "출연진",
    participantEntryLabel: "파트/아티스트",
    ageRatingLabel: "관람등급",
    durationLabel: "공연 시간",
    infoTabLabel: "공연 정보",
    distanceRefLabel: "무대",
    verifyMessage: "공연 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 공연에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "회차",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  musical: {
    eventLabel: "공연",
    venueLabel: "공연장",
    sessionLabel: "회차",
    descriptionLabel: "작품설명",
    reviewLabel: "관람후기",
    expectationLabel: "기대평",
    participantLabel: "출연진",
    participantEntryLabel: "캐릭터/배우",
    ageRatingLabel: "관람등급",
    durationLabel: "공연 시간",
    infoTabLabel: "공연 정보",
    distanceRefLabel: "무대",
    verifyMessage: "공연 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 공연에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "회차",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  sports: {
    eventLabel: "경기",
    venueLabel: "경기장",
    sessionLabel: "경기일",
    descriptionLabel: "경기설명",
    reviewLabel: "관전후기",
    expectationLabel: "응원글",
    participantLabel: "선수단",
    participantEntryLabel: "포지션/선수",
    ageRatingLabel: "입장제한",
    durationLabel: "경기 시간",
    infoTabLabel: "경기 정보",
    distanceRefLabel: "필드",
    verifyMessage: "경기 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 경기에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "경기일",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  classical: {
    eventLabel: "연주회",
    venueLabel: "연주홀",
    sessionLabel: "연주회차",
    descriptionLabel: "연주설명",
    reviewLabel: "감상후기",
    expectationLabel: "기대평",
    participantLabel: "연주자",
    participantEntryLabel: "프로그램/연주자",
    ageRatingLabel: "관람등급",
    durationLabel: "연주 시간",
    infoTabLabel: "연주회 정보",
    distanceRefLabel: "무대",
    verifyMessage: "연주회 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 연주회에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "연주회차",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  exhibition: {
    eventLabel: "전시",
    venueLabel: "전시관",
    sessionLabel: "전시기간",
    descriptionLabel: "전시설명",
    reviewLabel: "관람후기",
    expectationLabel: "기대평",
    participantLabel: "참여작가",
    participantEntryLabel: "섹션/작가",
    ageRatingLabel: "관람등급",
    durationLabel: "관람 시간",
    infoTabLabel: "전시 정보",
    distanceRefLabel: "전시물",
    verifyMessage: "전시 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 전시에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "관람일",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  festival: {
    eventLabel: "축제",
    venueLabel: "축제장",
    sessionLabel: "축제일",
    descriptionLabel: "축제설명",
    reviewLabel: "참여후기",
    expectationLabel: "기대글",
    participantLabel: "참여진",
    participantEntryLabel: "스테이지/아티스트",
    ageRatingLabel: "입장등급",
    durationLabel: "축제 시간",
    infoTabLabel: "축제 정보",
    distanceRefLabel: "스테이지",
    verifyMessage: "축제 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 축제에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "축제일",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  education: {
    eventLabel: "강좌",
    venueLabel: "강의실",
    sessionLabel: "회차",
    descriptionLabel: "강좌 설명",
    reviewLabel: "수강후기",
    expectationLabel: "기대평",
    participantLabel: "강사진",
    participantEntryLabel: "과목/강사",
    ageRatingLabel: "수강등급",
    durationLabel: "수업 시간",
    infoTabLabel: "강좌 정보",
    distanceRefLabel: "강단",
    verifyMessage: "수업 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 강좌에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "회차",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
  civic: {
    eventLabel: "프로그램",
    venueLabel: "장소",
    sessionLabel: "회차",
    descriptionLabel: "프로그램 설명",
    reviewLabel: "참여후기",
    expectationLabel: "기대글",
    participantLabel: "운영진",
    participantEntryLabel: "프로그램/담당자",
    ageRatingLabel: "참가등급",
    durationLabel: "프로그램 시간",
    infoTabLabel: "프로그램 정보",
    distanceRefLabel: "진행석",
    verifyMessage: "참가 당일 본인 확인이 필요합니다. 신분증을 지참해주세요.",
    bidPrompt: "이 프로그램에 얼마까지 낼 의향이 있으세요?",
    sessionPickerLabel: "회차",
    ctaVerb: "예매",
    ticketNoun: "티켓",
  },
};

export function getOrganizerLabels(category?: string | null): OrganizerLabels {
  if (!category) return ORGANIZER_LABELS.concert;
  return ORGANIZER_LABELS[category.toLowerCase()] ?? ORGANIZER_LABELS.concert;
}

/**
 * Domain-specific community widget configuration.
 * Determines which community features are prioritized per event category.
 */
export interface CommunityWidgetConfig {
  /** Primary widget type shown at top of community feed */
  primaryWidget:
    | "setlist_vote"
    | "cast_info"
    | "match_prediction"
    | "visitor_guide"
    | "lineup_vote"
    | "live_chat";
  /** Label for the expectation vote */
  expectationLabel: string;
  /** Label for community tab header */
  communityHeaderLabel: string;
  /** Placeholder for comment input */
  commentPlaceholder: string;
  /** Whether to show "같이 가기" buddy feature prominently */
  showBuddyFinder: boolean;
}

export const COMMUNITY_WIDGET_CONFIG: Record<string, CommunityWidgetConfig> = {
  concert: {
    primaryWidget: "setlist_vote",
    expectationLabel: "이 공연, 기대돼요!",
    communityHeaderLabel: "팬 커뮤니티",
    commentPlaceholder: "기대평을 남겨보세요...",
    showBuddyFinder: false, // TODO: 같이 가기(Buddy Finder) 기능 구현 완료 시 재활성화
  },
  musical: {
    primaryWidget: "cast_info",
    expectationLabel: "이 작품, 기대돼요!",
    communityHeaderLabel: "서포터 커뮤니티",
    commentPlaceholder: "캐스팅 후기나 기대평을 남겨보세요...",
    showBuddyFinder: false, // TODO: 같이 가기(Buddy Finder) 기능 구현 완료 시 재활성화
  },
  sports: {
    primaryWidget: "match_prediction",
    expectationLabel: "승리를 응원해요!",
    communityHeaderLabel: "서포터 커뮤니티",
    commentPlaceholder: "응원 메시지를 남겨보세요...",
    showBuddyFinder: false, // TODO: 같이 가기(Buddy Finder) 기능 구현 완료 시 재활성화
  },
  classical: {
    primaryWidget: "setlist_vote",
    expectationLabel: "이 연주회, 기대돼요!",
    communityHeaderLabel: "동호회",
    commentPlaceholder: "감상평을 남겨보세요...",
    showBuddyFinder: false,
  },
  exhibition: {
    primaryWidget: "visitor_guide",
    expectationLabel: "이 전시, 기대돼요!",
    communityHeaderLabel: "관람 커뮤니티",
    commentPlaceholder: "관람 팁이나 후기를 남겨보세요...",
    showBuddyFinder: false,
  },
  festival: {
    primaryWidget: "lineup_vote",
    expectationLabel: "이 축제, 기대돼요!",
    communityHeaderLabel: "크루 커뮤니티",
    commentPlaceholder: "축제 준비 이야기를 나눠보세요...",
    showBuddyFinder: false, // TODO: 같이 가기(Buddy Finder) 기능 구현 완료 시 재활성화
  },
  education: {
    primaryWidget: "visitor_guide",
    expectationLabel: "이 강좌, 기대돼요!",
    communityHeaderLabel: "학습 커뮤니티",
    commentPlaceholder: "수강 후기를 남겨보세요...",
    showBuddyFinder: false,
  },
  civic: {
    primaryWidget: "visitor_guide",
    expectationLabel: "이 프로그램, 기대돼요!",
    communityHeaderLabel: "시민 커뮤니티",
    commentPlaceholder: "참여 후기를 남겨보세요...",
    showBuddyFinder: false,
  },
};

export function getCommunityWidgetConfig(
  category?: string | null,
): CommunityWidgetConfig {
  if (!category) return COMMUNITY_WIDGET_CONFIG.concert;
  return (
    COMMUNITY_WIDGET_CONFIG[category.toLowerCase()] ??
    COMMUNITY_WIDGET_CONFIG.concert
  );
}

/**
 * Returns the focal-point label shown on venue maps.
 * Returns null for categories without a focal point (e.g. exhibition).
 */
export function getFocalPointLabel(category?: string | null): string | null {
  switch (category?.toLowerCase()) {
    case "concert":
    case "musical":
    case "classical":
      return "STAGE";
    case "sports":
      return "FIELD";
    case "festival":
      return "MAIN STAGE";
    case "exhibition":
    case "education":
    case "civic":
      return null;
    default:
      return "STAGE";
  }
}

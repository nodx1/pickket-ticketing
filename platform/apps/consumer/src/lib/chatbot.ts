export interface KnowledgeEntry {
  id: string;
  category: "구매" | "결제" | "환불" | "리세일" | "계정" | "일반";
  keywords: string[];
  question: string;
  answer: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  feedback?: "helpful" | "not_helpful" | null;
  suggestedQuestions?: string[];
}

const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    id: "fair_allocation",
    category: "구매",
    keywords: [
      "공정배분",
      "추첨",
      "배분",
      "공정",
      "응모",
      "포인트",
      "ap",
      "당첨",
      "가중",
    ],
    question: "공정 추첨이란?",
    answer:
      "Pickket은 공정 추첨 알고리즘과 특허 기술에 기반한 공정 추첨 시스템입니다.\n\n" +
      "- AP를 투입해 응모하면, 많이 투입할수록 당첨 확률이 높아집니다\n" +
      "- 당첨 시 정가 결제가 보장되며, 정가보다 높게 결제되지 않습니다\n" +
      "- 노벨경제학상 수상 이론에 기반하여 수학적으로 공정성이 증명된 시스템입니다\n\n" +
      "응모 기간 중 언제든 참여할 수 있으며, 마감 후 자동으로 당첨 결과가 결정됩니다.",
  },
  {
    id: "fcfs",
    category: "구매",
    keywords: ["선착순", "먼저", "빨리", "바로", "즉시"],
    question: "선착순 구매는?",
    answer:
      "선착순(First-Come, First-Served) 방식은 먼저 구매하는 분에게 티켓이 배정됩니다.\n\n" +
      "- 판매 시작 시간에 맞춰 빠르게 구매해주세요\n" +
      "- 결제까지 완료해야 구매가 확정됩니다\n" +
      "- 인당 구매 수량 제한이 있을 수 있습니다 (보통 최대 4매)\n" +
      "- 대기열이 적용될 수 있으며, 순서대로 입장합니다",
  },
  {
    id: "lottery",
    category: "구매",
    keywords: ["추첨", "응모", "당첨", "랜덤", "무작위", "복권"],
    question: "추첨 방식은?",
    answer:
      "추첨(Lottery) 방식은 응모 후 무작위로 당첨자를 선정합니다.\n\n" +
      "- 응모 기간 내에 신청하면 됩니다 (선착순 아님)\n" +
      "- 응모 마감 후 공정한 무작위 추첨으로 당첨자가 결정됩니다\n" +
      "- AP를 많이 투입하면 당첨 가중치가 부여될 수 있습니다\n" +
      "- 당첨 시 안내 메일이 발송되며, 기한 내 결제를 완료해야 합니다",
  },
  {
    id: "fanclub",
    category: "구매",
    keywords: ["커뮤니티", "선구매", "멤버", "회원", "팬"],
    question: "커뮤니티 선구매란?",
    answer:
      "커뮤니티 선구매는 공식 커뮤니티 회원에게 우선 구매 기회를 제공합니다.\n\n" +
      "- 일반 판매 전에 먼저 구매할 수 있습니다\n" +
      "- 커뮤니티 회원 인증이 필요합니다\n" +
      "- 할인가가 적용되는 경우가 많습니다\n" +
      "- 인당 구매 수량 제한이 있습니다 (최대 4매)",
  },
  {
    id: "refund",
    category: "환불",
    keywords: ["환불", "취소", "돌려", "캔슬", "반환", "철회"],
    question: "환불은 어떻게?",
    answer:
      "환불 정책은 다음과 같습니다:\n\n" +
      "- 구매일로부터 7일 이내, 공연 10일 전까지 청약철회 가능\n" +
      "- 전자상거래법 제17조에 따라 공연일 이후 청약철회가 제한됩니다\n" +
      "- 환불 처리: 원래 결제 수단으로 3~5 영업일 내 환불\n" +
      "- 리세일로 구매한 티켓은 별도 환불 정책이 적용됩니다\n\n" +
      "환불 신청: support@pickket.kr 또는 1588-0000으로 문의해주세요.",
  },
  {
    id: "fee",
    category: "결제",
    keywords: ["수수료", "비용", "얼마", "무료", "추가"],
    question: "수수료가 있나요?",
    answer:
      "수수료 구조는 판매 유형에 따라 다릅니다:\n\n" +
      "**1차 판매 (공정배분/선착순/멤버십)**\n" +
      "- 수수료 정책은 결제 시 명확히 안내됩니다\n" +
      "- 모든 가격은 부가세 포함입니다\n\n" +
      "**리세일 (2차 거래)**\n" +
      "- 차익(판매가 − 원가)의 50%가 주최자에게, 10%가 플랫폼에 귀속\n" +
      "- 정가 양도 시 수수료 0원 · 구매자 추가 수수료 없음 (₩2,000 올인 포함)",
  },
  {
    id: "payment",
    category: "결제",
    keywords: ["결제", "카드", "페이", "계좌", "송금", "신용"],
    question: "결제 수단은?",
    answer:
      "다양한 결제 수단을 지원합니다:\n\n" +
      "- 신용/체크카드\n" +
      "- 카카오페이\n" +
      "- 네이버페이\n" +
      "- 토스페이\n" +
      "- 계좌이체\n\n" +
      "모든 결제는 토스페이먼츠 보안 결제를 통해 안전하게 처리됩니다.",
  },
  {
    id: "resale_how",
    category: "리세일",
    keywords: ["리세일", "양도", "되팔", "판매", "팔기", "되파"],
    question: "리세일 방법은?",
    answer:
      "보유한 티켓을 리세일 마켓에서 판매할 수 있습니다:\n\n" +
      "1. 마이페이지 > 내 티켓에서 판매할 티켓 선택\n" +
      '2. "리세일 등록" 버튼 클릭\n' +
      "3. 희망 판매가 입력\n" +
      "4. 매수 주문과 매칭되면 자동 체결\n\n" +
      "- 체결 시 차익의 50%(주최자)와 10%(플랫폼)가 차감됩니다. 정가 양도는 수수료 0원\n" +
      "- NFT 기반 티켓이므로 위변조가 불가능합니다",
  },
  {
    id: "resale_fee",
    category: "리세일",
    keywords: ["리세일수수료", "차익", "프리미엄", "주최자", "수수료"],
    question: "리세일 수수료는?",
    answer:
      "리세일 거래 시 **차익 기반** 수수료가 적용됩니다:\n\n" +
      "- **주최자 귀속**: 차익(판매가 − 원가)의 50%\n" +
      "- **플랫폼 수수료**: 차익의 10%\n" +
      "- **판매자 수취**: 원가 100% + 차익의 40%\n" +
      "- **정가 양도 시**: 수수료 0원, 원금 100% 보전\n\n" +
      "예시: 10만원 티켓을 15만원에 리세일 → 주최자 25,000원 / 플랫폼 5,000원 / 판매자 120,000원\n" +
      "구매자에게 추가 수수료는 없습니다. ₩2,000 예매수수료가 표시 가격에 포함되어 있습니다 (올인 가격).",
  },
  {
    id: "account_login",
    category: "계정",
    keywords: ["로그인", "비밀번호", "안됨", "접속", "못들어"],
    question: "로그인 문제",
    answer:
      "로그인에 문제가 있으시면 다음을 확인해주세요:\n\n" +
      "- 이메일 주소가 올바른지 확인\n" +
      "- Caps Lock이 켜져 있지 않은지 확인\n" +
      '- "비밀번호 찾기"를 통해 재설정 가능\n' +
      "- 소셜 로그인(카카오/네이버/구글)을 사용한 경우 해당 방식으로 로그인\n\n" +
      "그래도 해결되지 않으면 support@pickket.kr로 문의해주세요.",
  },
  {
    id: "account_register",
    category: "계정",
    keywords: ["가입", "등록", "시작", "회원가입", "새로"],
    question: "회원가입 방법",
    answer:
      "회원가입은 간단합니다:\n\n" +
      "1. 상단 메뉴에서 로그인/회원가입 클릭\n" +
      "2. 이메일, 이름, 비밀번호 입력\n" +
      "3. 이용약관 및 개인정보 처리방침 동의 (필수)\n" +
      "4. 가입 완료!\n\n" +
      "만 14세 이상만 가입할 수 있습니다.",
  },
  {
    id: "ticket_check",
    category: "구매",
    keywords: ["확인", "예매", "내역", "티켓", "구매내역", "주문"],
    question: "예매 확인 방법",
    answer:
      "구매한 티켓은 마이페이지에서 확인할 수 있습니다:\n\n" +
      "1. 상단 메뉴 > 마이페이지 클릭\n" +
      '2. "내 티켓" 탭에서 보유 티켓 목록 확인\n' +
      "3. 각 티켓의 상세 정보 (공연명, 좌석, QR코드 등) 확인 가능\n\n" +
      "구매 완료 시 이메일로도 확인 메일이 발송됩니다.",
  },
  {
    id: "fan_weight",
    category: "구매",
    keywords: ["가중치", "점수", "AP", "활동", "포인트"],
    question: "AP란?",
    answer:
      "AP는 팬 활동을 수치화한 리워드입니다:\n\n" +
      "- 공연 관람, 리뷰 작성, 커뮤니티 활동 등으로 AP가 쌓입니다\n" +
      "- 공정 추첨 시 AP를 많이 투입할수록 당첨 확률이 높아집니다\n" +
      "- 마이페이지 > AP 탭에서 현재 잔액과 등급을 확인할 수 있습니다\n" +
      "- 진정한 팬에게 더 많은 기회가 돌아가도록 설계된 시스템입니다",
  },
  {
    id: "price_cap",
    category: "리세일",
    keywords: ["상한", "암표", "제한", "상한가", "최대", "가격"],
    question: "리세일 가격 제한",
    answer:
      "Pickket은 하드 상한 대신 차익 기반 수수료로 가격을 억제합니다:\n\n" +
      "- 차익의 60%(주최자 50% + 플랫폼 10%)가 자동 환원\n" +
      "- 판매자는 차익의 40%만 가져가므로 폭리 유인이 자연 억제\n" +
      "- 주최자가 원하면 이벤트별 상한을 별도 설정 가능\n\n" +
      "예: 10만원 티켓을 30만원에 리세일 → 판매자 순이익 8만원 (차익 20만의 40%)",
  },
];

const FALLBACK_RESPONSE =
  "죄송해요, 해당 질문에 대한 답변을 찾지 못했어요.\n\n" +
  "더 자세한 도움이 필요하시면:\n" +
  "- 이메일: support@pickket.kr\n" +
  "- 전화: 1588-0000 (평일 09:00-18:00)\n\n" +
  '"문의하기" 탭에서 직접 문의를 남겨주셔도 됩니다.';

export const QUICK_QUESTIONS = [
  "공정 추첨이란?",
  "환불은 어떻게?",
  "수수료가 있나요?",
  "리세일 방법은?",
  "결제 수단은?",
  "로그인 문제",
];

export const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "안녕하세요! Pickket AI 도우미입니다 :)\n\n티켓 구매, 환불, 리세일 등 궁금한 점을 물어보세요.\n아래 빠른 질문을 눌러보셔도 좋아요!",
  timestamp: new Date(),
  suggestedQuestions: QUICK_QUESTIONS.slice(0, 4),
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function findBestMatch(input: string): KnowledgeEntry | null {
  const normalized = normalize(input);
  let bestEntry: KnowledgeEntry | null = null;
  let bestScore = 0;

  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (normalized.includes(normalize(keyword))) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestScore >= 1 ? bestEntry : null;
}

export function generateResponse(input: string): {
  content: string;
  suggestedQuestions?: string[];
} {
  const match = findBestMatch(input);

  if (!match) {
    return { content: FALLBACK_RESPONSE };
  }

  // Suggest related questions from the same or adjacent categories
  const related = KNOWLEDGE_BASE.filter(
    (e) => e.id !== match.id && e.category === match.category,
  )
    .slice(0, 2)
    .map((e) => e.question);

  // Add one from a different category
  const other = KNOWLEDGE_BASE.find(
    (e) => e.id !== match.id && e.category !== match.category,
  );
  if (other) related.push(other.question);

  return {
    content: match.answer,
    suggestedQuestions: related.length > 0 ? related : undefined,
  };
}

export function getTypingDelay(): number {
  return 800 + Math.random() * 700;
}

export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface DnaScores {
  F: number; // Fairness
  C: number; // Creativity
  E: number; // Empathy
  G: number; // Grit
}

export interface QuestionOption {
  text: string;
  scores: Partial<DnaScores>;
}

export interface Question {
  id: number;
  scenario: string;
  options: QuestionOption[];
}

export interface DnaResult {
  type: string;
  name: string;
  emoji: string;
  description: string;
  detail: string;
  bestRole: string;
}

export const DNA_AXES: {
  key: keyof DnaScores;
  label: string;
  color: string;
}[] = [
  { key: "F", label: "공정성", color: "#0a0a0a" },
  { key: "C", label: "창의성", color: "#7C3AED" },
  { key: "E", label: "공감력", color: "#EC4899" },
  { key: "G", label: "근성", color: "#00C9A7" },
];

export const QUESTIONS: Question[] = [
  {
    id: 1,
    scenario:
      "콘서트 티켓이 딱 1장 남았는데, 친구 2명이 모두 간절히 원합니다. 당신이라면?",
    options: [
      { text: "공정하게 동전 던지기로 결정한다", scores: { F: 3, G: 1 } },
      {
        text: "둘 다 포기시키고 새로운 공연을 같이 찾아본다",
        scores: { C: 3, E: 1 },
      },
      {
        text: "더 좋아하는 친구에게 양보하고 다음을 기약한다",
        scores: { E: 3, F: 1 },
      },
      {
        text: "직접 암표 시장을 뒤져서라도 한 장 더 구한다",
        scores: { G: 3, C: 1 },
      },
    ],
  },
  {
    id: 2,
    scenario:
      "팀 프로젝트에서 기존 방법이 전혀 안 통합니다. 데드라인은 일주일 후.",
    options: [
      {
        text: "처음부터 완전히 새로운 접근법을 제안한다",
        scores: { C: 3, G: 1 },
      },
      {
        text: "밤새서라도 기존 방법을 개선해서 돌아가게 만든다",
        scores: { G: 3, F: 1 },
      },
      { text: "팀원들의 의견을 모아 합의점을 찾는다", scores: { E: 3, C: 1 } },
      {
        text: "왜 안 되는지 근본 원인을 체계적으로 분석한다",
        scores: { F: 3, E: 1 },
      },
    ],
  },
  {
    id: 3,
    scenario:
      "암표상이 원가의 3배에 티켓을 팔고 있습니다. 당신이 플랫폼 대표라면?",
    options: [
      {
        text: "가격 상한제를 즉시 도입한다 (150% 이내)",
        scores: { F: 3, G: 1 },
      },
      {
        text: "블록체인 기반 전매 방지 시스템을 개발한다",
        scores: { C: 3, F: 1 },
      },
      {
        text: "피해 팬들의 이야기를 모아 캠페인을 시작한다",
        scores: { E: 3, C: 1 },
      },
      {
        text: "암표상을 역이용해서 공식 리세일 마켓을 만든다",
        scores: { G: 3, C: 2 },
      },
    ],
  },
  {
    id: 4,
    scenario:
      "서비스 런칭 후 유저 100명이 동시에 불만을 제기했습니다. 가장 먼저 하는 일은?",
    options: [
      {
        text: "한 명 한 명 직접 답변하며 상황을 파악한다",
        scores: { E: 3, G: 1 },
      },
      {
        text: "불만 데이터를 분류하고 근본 원인 패턴을 찾는다",
        scores: { F: 3, C: 1 },
      },
      {
        text: "임시 보상안을 즉시 내놓고 동시에 수정 작업에 돌입한다",
        scores: { G: 3, E: 1 },
      },
      {
        text: "불만을 역발상으로 활용해 더 좋은 기능을 기획한다",
        scores: { C: 3, F: 1 },
      },
    ],
  },
  {
    id: 5,
    scenario:
      "완벽한 결과물 vs 빠른 실행. 데드라인 3일 전, 퀄리티 80%인 상태에서 당신은?",
    options: [
      {
        text: "80%로 먼저 출시하고 피드백 받으며 개선한다",
        scores: { G: 3, C: 1 },
      },
      { text: "데드라인을 미루더라도 100%를 만든다", scores: { F: 3, G: 1 } },
      {
        text: "유저에게 가장 중요한 20%를 먼저 완성한다",
        scores: { E: 3, F: 1 },
      },
      {
        text: "팀과 함께 창의적인 숏컷을 찾아 95%까지 끌어올린다",
        scores: { C: 3, G: 2 },
      },
    ],
  },
  {
    id: 6,
    scenario:
      "AI가 티켓 배분에서 미세한 불공정을 만들었습니다. 출시 하루 전에 발견했다면?",
    options: [
      {
        text: "출시를 연기하고 반드시 고친다. 공정함에 타협은 없다",
        scores: { F: 3, E: 1 },
      },
      {
        text: "밤새 작업해서 출시 시간에 맞춰 수정한다",
        scores: { G: 3, F: 2 },
      },
      {
        text: "영향받는 유저를 먼저 파악하고 개별 안내 후 수정한다",
        scores: { E: 3, G: 1 },
      },
      {
        text: "근본적으로 AI 모델 구조를 재설계하는 방향을 제안한다",
        scores: { C: 3, F: 1 },
      },
    ],
  },
  {
    id: 7,
    scenario: "당신이 생각하는 '성공한 서비스'의 핵심 비결은?",
    options: [
      { text: "누구에게나 공정한 규칙과 투명한 시스템", scores: { F: 3 } },
      { text: "세상에 없던 새로운 경험을 만드는 것", scores: { C: 3 } },
      { text: "유저 한 명 한 명의 마음을 사로잡는 것", scores: { E: 3 } },
      { text: "끝까지 포기하지 않는 팀의 실행력", scores: { G: 3 } },
    ],
  },
];

const RESULTS: Record<string, DnaResult> = {
  FC: {
    type: "architect",
    name: "시스템 설계자",
    emoji: "🏗️",
    description: "공정한 구조를 처음부터 설계하는 사람",
    detail:
      "당신은 복잡한 문제를 우아한 시스템으로 풀어내는 능력이 있습니다. 공정 배분 같은 메커니즘 설계가 딱 맞는 사람이에요.",
    bestRole: "Backend Engineer / System Architect",
  },
  CF: {
    type: "architect",
    name: "시스템 설계자",
    emoji: "🏗️",
    description: "공정한 구조를 처음부터 설계하는 사람",
    detail:
      "당신은 복잡한 문제를 우아한 시스템으로 풀어내는 능력이 있습니다. 공정 배분 같은 메커니즘 설계가 딱 맞는 사람이에요.",
    bestRole: "Backend Engineer / System Architect",
  },
  FG: {
    type: "guardian",
    name: "공정성의 수호자",
    emoji: "🛡️",
    description: "규칙을 만들고 끝까지 지키는 사람",
    detail:
      "원칙을 세우고, 그 원칙이 깨지지 않도록 끝까지 지키는 당신. Pickket의 암표 방지 시스템을 책임질 수 있는 사람입니다.",
    bestRole: "QA Engineer / Policy Lead",
  },
  GF: {
    type: "guardian",
    name: "공정성의 수호자",
    emoji: "🛡️",
    description: "규칙을 만들고 끝까지 지키는 사람",
    detail:
      "원칙을 세우고, 그 원칙이 깨지지 않도록 끝까지 지키는 당신. Pickket의 암표 방지 시스템을 책임질 수 있는 사람입니다.",
    bestRole: "QA Engineer / Policy Lead",
  },
  CG: {
    type: "innovator",
    name: "혁신가",
    emoji: "🚀",
    description: "불가능을 가능으로 바꾸는 사람",
    detail:
      "새로운 아이디어를 실행력으로 현실로 만드는 당신. 아무도 생각 못한 기능을 빠르게 구현해내는 사람이에요.",
    bestRole: "Full-Stack Engineer / Product Manager",
  },
  GC: {
    type: "innovator",
    name: "혁신가",
    emoji: "🚀",
    description: "불가능을 가능으로 바꾸는 사람",
    detail:
      "새로운 아이디어를 실행력으로 현실로 만드는 당신. 아무도 생각 못한 기능을 빠르게 구현해내는 사람이에요.",
    bestRole: "Full-Stack Engineer / Product Manager",
  },
  EC: {
    type: "empath",
    name: "팬의 대변인",
    emoji: "💜",
    description: "유저의 마음을 읽고 제품에 녹이는 사람",
    detail:
      "팬이 무엇을 원하는지 누구보다 잘 알고, 그것을 창의적으로 제품에 반영하는 당신. UX의 핵심 인재입니다.",
    bestRole: "Product Designer / UX Researcher",
  },
  CE: {
    type: "empath",
    name: "팬의 대변인",
    emoji: "💜",
    description: "유저의 마음을 읽고 제품에 녹이는 사람",
    detail:
      "팬이 무엇을 원하는지 누구보다 잘 알고, 그것을 창의적으로 제품에 반영하는 당신. UX의 핵심 인재입니다.",
    bestRole: "Product Designer / UX Researcher",
  },
  EF: {
    type: "connector",
    name: "연결자",
    emoji: "🌉",
    description: "팬과 아티스트를 잇는 다리",
    detail:
      "공정함과 공감을 동시에 갖춘 당신. 팬과 아티스트, 그리고 팀 사이를 자연스럽게 연결하는 능력이 있습니다.",
    bestRole: "Community Manager / Partnership Lead",
  },
  FE: {
    type: "connector",
    name: "연결자",
    emoji: "🌉",
    description: "팬과 아티스트를 잇는 다리",
    detail:
      "공정함과 공감을 동시에 갖춘 당신. 팬과 아티스트, 그리고 팀 사이를 자연스럽게 연결하는 능력이 있습니다.",
    bestRole: "Community Manager / Partnership Lead",
  },
  EG: {
    type: "connector",
    name: "연결자",
    emoji: "🌉",
    description: "팬과 아티스트를 잇는 다리",
    detail:
      "공정함과 공감을 동시에 갖춘 당신. 팬과 아티스트, 그리고 팀 사이를 자연스럽게 연결하는 능력이 있습니다.",
    bestRole: "Community Manager / Partnership Lead",
  },
  GE: {
    type: "connector",
    name: "연결자",
    emoji: "🌉",
    description: "팬과 아티스트를 잇는 다리",
    detail:
      "공정함과 공감을 동시에 갖춘 당신. 팬과 아티스트, 그리고 팀 사이를 자연스럽게 연결하는 능력이 있습니다.",
    bestRole: "Community Manager / Partnership Lead",
  },
};

const ALLROUNDER: DnaResult = {
  type: "allrounder",
  name: "올라운더",
  emoji: "⭐",
  description: "모든 면에서 균형 잡힌 Pickket DNA",
  detail:
    "공정성, 창의성, 공감력, 근성을 골고루 갖춘 당신. 어떤 포지션이든 빛날 수 있는 만능 인재입니다.",
  bestRole: "Any Role — You're a natural fit!",
};

export function calculateScores(answers: number[]): DnaScores {
  const scores: DnaScores = { F: 0, C: 0, E: 0, G: 0 };

  answers.forEach((optionIndex, questionIndex) => {
    const question = QUESTIONS[questionIndex];
    if (!question) return;
    const option = question.options[optionIndex];
    if (!option) return;

    for (const [key, value] of Object.entries(option.scores)) {
      scores[key as keyof DnaScores] += value || 0;
    }
  });

  // Normalize to 0-100
  const maxPossible = 3 * QUESTIONS.length; // max 3 points per question per axis
  return {
    F: Math.round((scores.F / maxPossible) * 100),
    C: Math.round((scores.C / maxPossible) * 100),
    E: Math.round((scores.E / maxPossible) * 100),
    G: Math.round((scores.G / maxPossible) * 100),
  };
}

export function getResult(scores: DnaScores): DnaResult {
  const entries = Object.entries(scores) as [keyof DnaScores, number][];
  entries.sort((a, b) => b[1] - a[1]);

  const max = entries[0][1];
  const min = entries[entries.length - 1][1];

  // All axes within 15 points → allrounder
  if (max - min < 15) return ALLROUNDER;

  const top2Key = entries[0][0] + entries[1][0];
  return RESULTS[top2Key] || ALLROUNDER;
}

export function getShareText(result: DnaResult, scores: DnaScores): string {
  return (
    `🧬 나의 Pickket DNA: ${result.emoji} ${result.name}\n\n` +
    `공정성 ${scores.F}% | 창의성 ${scores.C}% | 공감력 ${scores.E}% | 근성 ${scores.G}%\n\n` +
    `"${result.description}"\n\n` +
    `나도 테스트 해보기 → https://pickket.co.kr/careers`
  );
}

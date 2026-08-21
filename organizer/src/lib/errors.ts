export const ERR = {
  SERVER: "서버 오류가 발생했습니다",
  FORBIDDEN: "접근 권한이 없습니다",
  UNAUTHORIZED: "로그인이 필요합니다",
  NOT_FOUND: "데이터를 찾을 수 없습니다",
  REQUIRED: "필수 입력 항목입니다",
  INVALID_INPUT: "입력값이 올바르지 않습니다",
  DUPLICATE: "이미 존재하는 데이터입니다",
  RATE_LIMIT: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요",
} as const;

export type ErrorMessage = (typeof ERR)[keyof typeof ERR];

/**
 * MCP (Model Context Protocol) 타입
 * AI 에이전트의 앱 내 도구 사용을 위한 프로토콜 정의
 * 피처플래그: MCP_SERVER
 */

export type McpToolName =
  | "search_events"
  | "get_event_detail"
  | "check_availability"
  | "start_booking"
  | "get_schedule"
  | "get_fan_score"
  | "get_recommendations";

export interface McpToolCall {
  id: string;
  tool: McpToolName;
  params: Record<string, unknown>;
  timestamp: string;
}

export interface McpToolResult {
  id: string;
  tool: McpToolName;
  result: unknown;
  error?: string;
  duration_ms: number;
}

export interface McpConversation {
  id: string;
  messages: McpMessage[];
  tool_calls: McpToolCall[];
  tool_results: McpToolResult[];
}

export interface McpMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: McpToolName;
}

/** MCP 도구 정의 (서버 등록용) */
export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "search_events",
    description: "자연어로 이벤트 검색",
    parameters: {
      query: { type: "string", description: "검색 쿼리", required: true },
      category: { type: "string", description: "카테고리 필터" },
      date_range: { type: "string", description: "날짜 범위 (ISO)" },
    },
  },
  {
    name: "get_event_detail",
    description: "이벤트 상세 정보 조회",
    parameters: {
      event_id: { type: "string", description: "이벤트 ID", required: true },
    },
  },
  {
    name: "check_availability",
    description: "좌석/티어 잔여 확인",
    parameters: {
      event_id: { type: "string", description: "이벤트 ID", required: true },
      tier_id: { type: "string", description: "티어 ID" },
    },
  },
  {
    name: "start_booking",
    description: "예매 프로세스 시작",
    parameters: {
      event_id: { type: "string", description: "이벤트 ID", required: true },
      tier_id: { type: "string", description: "티어 ID", required: true },
      quantity: { type: "number", description: "수량", required: true },
    },
  },
  {
    name: "get_schedule",
    description: "일정 피드 조회",
    parameters: {
      date: { type: "string", description: "날짜 (YYYY-MM-DD)" },
      category: { type: "string", description: "카테고리 필터" },
    },
  },
  {
    name: "get_fan_score",
    description: "팬 스코어 조회",
    parameters: {},
  },
  {
    name: "get_recommendations",
    description: "맞춤 추천 조회",
    parameters: {
      limit: { type: "number", description: "추천 개수" },
    },
  },
];

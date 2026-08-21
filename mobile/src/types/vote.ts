/**
 * 데일리 투표 + 퀴즈 타입
 * 피처플래그: DAILY_VOTE, DAILY_QUIZ
 */

export interface VoteOption {
  id: string;
  label: string;
  image_url?: string;
  vote_count: number;
}

export interface DailyVote {
  id: string;
  question: string;
  options: VoteOption[];
  total_votes: number;
  user_voted_id?: string;
  expires_at: string;
  xp_reward: number;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  xp_reward: number;
  category: string;
}

export interface DailyQuiz {
  id: string;
  questions: QuizQuestion[];
  completed: boolean;
  score: number;
  max_score: number;
}

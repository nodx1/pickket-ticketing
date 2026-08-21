"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { BarChart3, Check } from "lucide-react";
import { getSurveyStats, submitSurveyResponse } from "@pickket/lib/api";
import { fmt } from "../detail-helpers";

interface PollOption {
  id: string;
  text: string;
  votes: number;
  pct: number;
}

interface PollData {
  id: string;
  question: string;
  totalVotes: number;
  options: PollOption[];
}

function SinglePoll({ poll }: { poll: PollData }) {
  const t = useTranslations("event.poll");
  const [votedOption, setVotedOption] = useState<string | null>(null);
  const [localPoll, setLocalPoll] = useState(poll);
  const [submitting, setSubmitting] = useState(false);

  const handleVote = useCallback(
    async (optionId: string) => {
      if (votedOption || submitting) return;
      setSubmitting(true);
      setVotedOption(optionId);

      // Optimistic update
      const newTotal = localPoll.totalVotes + 1;
      const updatedOptions = localPoll.options.map((opt) => {
        const newVotes = opt.id === optionId ? opt.votes + 1 : opt.votes;
        return {
          ...opt,
          votes: newVotes,
          pct: Math.round((newVotes / newTotal) * 100),
        };
      });
      setLocalPoll({
        ...localPoll,
        totalVotes: newTotal,
        options: updatedOptions,
      });

      try {
        await submitSurveyResponse(poll.id, { choice: optionId });
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status === 409) {
          // Already voted — keep current state
        } else {
          // Rollback
          setVotedOption(null);
          setLocalPoll(poll);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [votedOption, submitting, localPoll, poll],
  );

  return (
    <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 className="h-4 w-4 text-primary/70" />
        <span className="text-sm font-semibold text-foreground">
          {localPoll.question}
        </span>
      </div>
      <div className="space-y-2">
        {localPoll.options.map((opt) => {
          const isVoted = votedOption === opt.id;
          const showResults = votedOption !== null;

          return (
            <button
              key={opt.id}
              onClick={() => handleVote(opt.id)}
              disabled={!!votedOption || submitting}
              className={`relative w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all overflow-hidden ${
                isVoted
                  ? "border-2 border-primary bg-primary/10 shadow-sm shadow-primary/15"
                  : votedOption
                    ? "border border-white/8 bg-white/5"
                    : "border border-white/8 hover:border-primary/40 hover:bg-primary/5 cursor-pointer"
              }`}
            >
              {showResults && (
                <motion.div
                  className={`absolute inset-y-0 left-0 rounded-xl ${isVoted ? "bg-primary/15" : "bg-white/5"}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${opt.pct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              )}
              <div className="relative flex items-center justify-between">
                <span className="flex items-center gap-2">
                  {isVoted && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="flex items-center justify-center h-5 w-5 rounded-full bg-primary text-white shrink-0"
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </motion.span>
                  )}
                  <span
                    className={`font-medium ${isVoted ? "text-primary/70 font-semibold" : "text-foreground"}`}
                  >
                    {opt.text}
                  </span>
                </span>
                {showResults && (
                  <span
                    className={`text-xs font-bold ml-2 ${isVoted ? "text-primary/70" : "text-muted-foreground"}`}
                  >
                    {opt.pct}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {votedOption ? (
          <span className="flex items-center gap-1 text-xs-plus text-primary/70 font-medium">
            <Check className="h-3 w-3" />
            {t("voted")}
          </span>
        ) : (
          <span className="text-xs-plus text-muted-foreground">
            {t("castVote")}
          </span>
        )}
        <span className="text-xs-plus text-muted-foreground">
          {t("participantCount", { count: fmt(localPoll.totalVotes) ?? "" })}
        </span>
      </div>
    </div>
  );
}

export function PollCards({ eventId }: { eventId: string }) {
  const [polls, setPolls] = useState<PollData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchPolls() {
      const surveyIds = [`poll-${eventId}-1`, `poll-${eventId}-2`];
      const results: PollData[] = [];

      for (const surveyId of surveyIds) {
        try {
          const res = await getSurveyStats(surveyId);
          const data = res.data;
          const totalVotes = data.total_responses ?? 0;
          const distribution = data.answers_distribution ?? {};
          const choiceDist = distribution.choice ?? {};
          const question =
            ((data as unknown as Record<string, unknown>).question as string) ??
            surveyId;

          if (totalVotes > 0 || Object.keys(choiceDist).length > 0) {
            const options: PollOption[] = Object.entries(choiceDist).map(
              ([key, count]) => ({
                id: key,
                text: key,
                votes: count,
                pct:
                  totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0,
              }),
            );
            results.push({
              id: surveyId,
              question,
              totalVotes,
              options,
            });
          }
        } catch {
          // Survey doesn't exist — skip
        }
      }

      if (!cancelled) {
        setPolls(results);
        setLoading(false);
      }
    }

    fetchPolls();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (loading) return null;
  if (polls.length === 0) return null;

  return (
    <div className="space-y-4">
      {polls.map((poll) => (
        <SinglePoll key={poll.id} poll={poll} />
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";
import { MARKETING_CONSENT_TEXT } from "@/lib/notification/consent-wording";
import { CheckoutProgress } from "../../_components/checkout-progress";

const detailsSchema = z.object({
  buyerName: z.string().min(2, "이름을 입력해주세요"),
  buyerEmail: z.email("올바른 이메일 형식을 입력해주세요"),
  buyerPhone: z.string().regex(/^01[016789]-?\d{3,4}-?\d{4}$/, "전화번호 형식이 올바르지 않습니다"),
});

interface CheckoutDetailsStepProps {
  eventSlug: string;
  eventId: string;
  eventTitle: string;
  ageRating: string;
  questions: Array<{
    id: string;
    label: string;
    questionType: "short_text" | "long_text" | "single_choice" | "multiple_choice" | "checkbox";
    isRequired: boolean;
    options: string[];
  }>;
}

export function CheckoutDetailsStep({ eventSlug, eventTitle, ageRating, questions }: CheckoutDetailsStepProps) {
  const router = useRouter();
  const { selectedItems, buyerInfo, answers, setBuyerInfo, setAnswer, marketingConsent, setMarketingConsent } = useCheckoutStore();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // persist(skipHydration) 복원 전에 빈 상태로 판정해 1단계로 튕기는 레이스 방지 —
    // sessionStorage 는 동기 복원이므로 rehydrate 후 스토어 최신값으로 판정한다.
    void useCheckoutStore.persist.rehydrate();
    if (useCheckoutStore.getState().selectedItems.length === 0) {
      router.replace(`/e/${eventSlug}/checkout`);
    }
  }, [eventSlug, router, selectedItems.length]);

  function handleNext() {
    const parsed = detailsSchema.safeParse(buyerInfo);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      setError(firstIssue?.message ?? "입력값을 확인해주세요");
      // 첫 에러 필드로 포커스 — 모바일에서 에러 문구만으로는 어느 칸인지 찾기 어렵다.
      const fieldId: Record<string, string> = {
        buyerName: "buyer-name",
        buyerEmail: "buyer-email",
        buyerPhone: "buyer-phone",
      };
      const target = fieldId[String(firstIssue?.path[0] ?? "")];
      if (target) document.getElementById(target)?.focus();
      return;
    }
    const missingQuestion = questions.find((question) => {
      if (!question.isRequired) {
        return false;
      }
      const value = answers[question.id];
      if (Array.isArray(value)) {
        return value.length === 0;
      }
      return !value;
    });
    if (missingQuestion) {
      setError(`필수 질문에 답변해주세요: ${missingQuestion.label}`);
      return;
    }
    router.push(`/e/${eventSlug}/checkout/payment`);
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <CheckoutProgress current={2} />
      <div className="mx-auto mt-6 max-w-3xl">
        <Card className="border-border bg-card/95">
          <CardHeader>
            {/* 🔴 `CardTitle` 은 h3 라 이 페이지에 h1 이 하나도 없었다 (2026-07-31 실측).
                결제 3단계 전부 h3 로 시작해 화면낭독기가 문서 구조를 못 잡는다.
                제목 자체를 h1 으로 올린다 — 각 단계가 독립 페이지다. */}
            <CardTitle as="h1" className="text-3xl font-black tracking-[-0.04em] text-foreground">2단계 · 구매자 정보
            </CardTitle>
            <p className="text-sm text-muted-foreground">{eventTitle}</p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="buyer-name">이름</Label>
              <Input
                id="buyer-name"
                name="name"
                autoComplete="name"
                value={buyerInfo.buyerName}
                onChange={(event) => setBuyerInfo({ buyerName: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-email">이메일</Label>
              <Input
                id="buyer-email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                value={buyerInfo.buyerEmail}
                onChange={(event) => setBuyerInfo({ buyerEmail: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-phone">전화번호</Label>
              <Input
                id="buyer-phone"
                type="tel"
                name="tel"
                autoComplete="tel"
                inputMode="tel"
                placeholder="010-1234-5678"
                value={buyerInfo.buyerPhone}
                onChange={(event) => setBuyerInfo({ buyerPhone: event.target.value })}
              />
            </div>

            {ageRating === "18+" ? (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-muted-foreground">
                본 이벤트는 만 18세 이상만 입장 가능합니다.
              </div>
            ) : null}

            {/* §3-2: 마케팅 수신동의(선택, 기본 미체크). ⚠️ 문구 법무 검토 대기. */}
            <label className="flex items-start gap-3 rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0"
                checked={marketingConsent}
                onChange={(event) => setMarketingConsent(event.target.checked)}
              />
              <span>{MARKETING_CONSENT_TEXT}</span>
            </label>

            {/*
              🔴 영수증 발행 입력을 걷어냈다 (2026-08-01, 대표 실구매 지적).

              카드 결제는 카드사가 이미 영수증을 발행한다. 15,000원 티켓을 사면서
              세금계산서를 묻고, 그 옆에 「현금영수증(준비 중)」이 떠 있었다 —
              구매자는 "안 고르면 손해인가?" 하고 **결제 직전에 멈춘다.**

              게다가 아무것도 실제로 발행되지 않았다: `issueTaxInvoice()`·`issueCashReceipt()`
              는 반환값만 만드는 스텁이고, 주최자 대시보드에 영수증 발행 화면이 없다.
              **묻기만 하고 아무 일도 일어나지 않는 입력**이었다.

              ⚠️ 서버는 그대로 둔다 — `initiate` 의 zod `receiptType` 은 optional 이라
                 안 보내면 그만이고, `lib/tax/*`·주문 영수증 라우트는 나중에 주최자
                 영수증 기능을 붙일 때 쓴다. **화면만** 걷어낸 것이다.
            */}
            {questions.length > 0 ? (
              <div className="space-y-4 rounded-lg border border-border bg-muted p-5">
                <p className="text-sm font-semibold text-foreground">추가 정보</p>
                {questions.map((question) => (
                  <div key={question.id} className="space-y-2">
                    <Label>{question.label}</Label>
                    {question.questionType === "short_text" || question.questionType === "long_text" ? (
                      <Input
                        value={typeof answers[question.id] === "string" ? String(answers[question.id]) : ""}
                        onChange={(event) => setAnswer(question.id, event.target.value)}
                      />
                    ) : (
                      <div className="space-y-2">
                        {question.options.map((option) => {
                          const current = answers[question.id];
                          const checked = Array.isArray(current) ? current.includes(option) : current === option;
                          return (
                            <label key={option} className="flex items-center gap-3 text-sm text-muted-foreground">
                              <input
                                type={question.questionType === "single_choice" ? "radio" : "checkbox"}
                                name={question.id}
                                checked={checked}
                                onChange={(event) => {
                                  if (question.questionType === "single_choice") {
                                    setAnswer(question.id, option);
                                  } else {
                                    const currentValues = Array.isArray(current) ? current : [];
                                    setAnswer(
                                      question.id,
                                      event.target.checked
                                        ? [...currentValues, option]
                                        : currentValues.filter((value) => value !== option),
                                    );
                                  }
                                }}
                              />
                              {option}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <div className="flex justify-end">
              <Button onClick={handleNext}>다음</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * 결제 화면 — 토스페이먼츠 WebView 결제
 *
 * v2 payment flow:
 *   1. POST /orders/{orderId}/payment/prepare → redirect_url(토스 결제창 웹페이지)
 *   2. WebView로 redirect_url 로드 → 토스 결제창
 *      - 카드사/은행/간편결제 앱 전환은 app-scheme 을 Linking 으로 외부앱 실행(onShouldStart…)
 *   3. 결제 성공 시 success_url 콜백(pickket://payment/success) → pg_transaction_id(paymentKey) 파싱
 *   4. POST /orders/{orderId}/pay → 결제 확인(pg_provider=toss)
 *   5. 실패/취소 시 에러 화면
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, ActivityIndicator, Alert, StyleSheet, BackHandler, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { WebView } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { usePreparePayment, useConfirmPayment } from "@/hooks/usePayment";
import { generateIdempotencyKey } from "@/config/api";
import { Button } from "@/components/ui/Button";
import { formatKRW } from "@/lib/format";
import { trackPurchaseStart, trackPurchaseComplete } from "@/lib/analytics";
import { authenticateForPayment } from "@/lib/biometric";
import * as haptics from "@/lib/haptics";
import {
  matchesScheme,
  isExternalAppScheme,
  isAllowedPgHost,
  parsePaymentCallback,
} from "@/lib/tossWebview";

// Deep link callback URLs for 토스 결제 redirect
const SUCCESS_SCHEME = "pickket://payment/success";
const FAIL_SCHEME = "pickket://payment/fail";

/**
 * PG redirect_url 사전 검증 — MITM/서버 취약점으로 조작된 URL 차단(P2-C27).
 * onShouldStartLoadWithRequest는 Android 초기 URL에 보장 없으므로 WebView source 주입 전에 검증.
 */
const ALLOWED_PG_REDIRECT_HOSTS = new Set([
  "api.pickket.kr",
  "api-stg.pickket.kr",
  "pickket.kr",
  "pay.toss.im",
  "www.tosspayments.com",
  "pgweb.tosspayments.com",
  "js.tosspayments.com",
  "api.tosspayments.com",
]);

function validateRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // HTTPS만 허용 — HTTP 다운그레이드 거부
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return ALLOWED_PG_REDIRECT_HOSTS.has(host) || [...ALLOWED_PG_REDIRECT_HOSTS].some((h) => host.endsWith("." + h));
  } catch {
    return false;
  }
}

type PaymentState = "preparing" | "paying" | "confirming" | "success" | "failed" | "cancelled";

export default function PaymentScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; orderId: string }>();
  const orderId = typeof params.orderId === "string" ? params.orderId : params.orderId?.[0] ?? "";

  const prepareMutation = usePreparePayment();
  const confirmMutation = useConfirmPayment();

  const [state, setState] = useState<PaymentState>("preparing");
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const hasConfirmed = useRef(false);
  const hasTrackedStart = useRef(false);
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());

  // Step 1: 생체 인증 → Prepare payment on mount
  useEffect(() => {
    if (!orderId) {
      setState("failed");
      setErrorMessage(t("payment.missingOrderId"));
      return;
    }

    // 결제 전 생체 인증 (Face ID / 지문)
    authenticateForPayment().then((authResult) => {
      if (!authResult.success) {
        setState("failed");
        setErrorMessage(t("payment.authRequired"));
        return;
      }

      prepareMutation.mutate(
        {
          orderId,
          idempotencyKey: idempotencyKeyRef.current,
          successUrl: SUCCESS_SCHEME,
          failUrl: FAIL_SCHEME,
        },
        {
          onSuccess: (result) => {
            // redirect_url 사전 호스트·HTTPS 검증 — Android WebView 초기 URL 우회 방어(P2-C27)
            if (!validateRedirectUrl(result.redirect_url)) {
              setState("failed");
              setErrorMessage(t("payment.invalidRedirectUrl"));
              return;
            }
            setRedirectUrl(result.redirect_url);
            setPaymentAmount(result.amount);
            setState("paying");
            if (!hasTrackedStart.current) {
              hasTrackedStart.current = true;
              trackPurchaseStart(params.id as string, null, result.amount);
            }
          },
          onError: (error: Error) => {
            setState("failed");
            setErrorMessage(error.message);
          },
        },
      );
    });
  }, [orderId]);

  // Step 4: Confirm payment with backend
  const confirmPayment = useCallback(
    (pgProvider: string, pgTransactionId: string, paymentId?: string) => {
      setState("confirming");

      confirmMutation.mutate(
        { orderId, pgProvider, pgTransactionId, paymentId, idempotencyKey: idempotencyKeyRef.current },
        {
          onSuccess: () => {
            setState("success");
            haptics.success();
            trackPurchaseComplete(
              params.id as string,
              null,
              paymentAmount,
              orderId,
            );
          },
          onError: (error: Error) => {
            setState("failed");
            setErrorMessage(error.message);
          },
        },
      );
    },
    [orderId, confirmMutation],
  );

  const handlePaymentCallback = useCallback(
    (url: string) => {
      const cb = parsePaymentCallback(url, SUCCESS_SCHEME, FAIL_SCHEME);

      if (cb.kind === "success") {
        if (!cb.pgTransactionId) {
          setErrorMessage(t("payment.missingTransactionId"));
          setState("failed");
          return false;
        }
        if (!hasConfirmed.current) {
          hasConfirmed.current = true;
          confirmPayment(cb.pgProvider ?? "toss", cb.pgTransactionId, cb.paymentId);
        }
        return false;
      }

      if (cb.kind === "fail") {
        if (hasConfirmed.current) return false;
        hasConfirmed.current = true;
        setState("failed");
        setErrorMessage(cb.reason ?? t("payment.failed"));
        return false;
      }

      return true;
    },
    [confirmPayment, t],
  );

  const handleDone = useCallback(() => {
    // Navigate to tickets tab
    router.replace("/(tabs)/tickets");
  }, [router]);

  const handleRetry = useCallback(() => {
    setState("preparing");
    hasConfirmed.current = false;
    setRedirectUrl(null);
    setErrorMessage(null);
    // 재시도 시 동일한 idempotency key 재사용 → 서버 중복 결제 세션 방지
    prepareMutation.mutate(
      {
        orderId,
        idempotencyKey: idempotencyKeyRef.current,
        successUrl: SUCCESS_SCHEME,
        failUrl: FAIL_SCHEME,
      },
      {
        onSuccess: (result) => {
          if (!validateRedirectUrl(result.redirect_url)) {
            setState("failed");
            setErrorMessage(t("payment.invalidRedirectUrl"));
            return;
          }
          setRedirectUrl(result.redirect_url);
          setPaymentAmount(result.amount);
          setState("paying");
        },
        onError: (error: Error) => {
          setState("failed");
          setErrorMessage(error.message);
        },
      },
    );
  }, [orderId, prepareMutation]);

  const handleCancel = useCallback(() => {
    Alert.alert(t("common.cancel"), t("payment.cancelled"), [
      { text: t("common.back"), style: "cancel" },
      {
        text: t("common.confirm"),
        onPress: () => router.back(),
      },
    ]);
  }, [router, t]);

  // Android 하드웨어 백 버튼: 결제/확인 중 차단
  useEffect(() => {
    if (state !== "paying" && state !== "confirming") return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (state === "paying") {
        handleCancel();
        return true;
      }
      if (state === "confirming") {
        return true; // 완전 차단
      }
      return false;
    });
    return () => handler.remove();
  }, [state, handleCancel]);

  useEffect(() => {
    if (state !== "paying" || !redirectUrl) return;
    handlePaymentCallback(redirectUrl);
  }, [state, redirectUrl, handlePaymentCallback]);

  const shouldRenderWebView =
    state === "paying" &&
    !!redirectUrl &&
    !matchesScheme(redirectUrl, SUCCESS_SCHEME) &&
    !matchesScheme(redirectUrl, FAIL_SCHEME);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen
        options={{
          title: t("payment.title"),
          gestureEnabled: state !== "paying" && state !== "confirming",
          headerLeft: state === "paying"
            ? () => (
                <Text
                  onPress={handleCancel}
                  style={[typography.body, { color: colors.primary, paddingHorizontal: spacing.sm }]}
                >
                  {t("common.cancel")}
                </Text>
              )
            : undefined,
        }}
      />

      {/* Preparing */}
      {(state === "preparing" || state === "confirming") && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.lg }]}>
            {state === "preparing" ? t("payment.preparing") : t("booking.processing")}
          </Text>
          {/* 결제 준비 완료 후 금액 표시 — PG WebView 진입 전 최종 확인용(P2-C10) */}
          {paymentAmount > 0 && (
            <Text style={[typography.h2, { color: colors.primary, marginTop: spacing.md }]}>
              {formatKRW(paymentAmount)}
            </Text>
          )}
        </View>
      )}

      {/* WebView: PG payment UI */}
      {shouldRenderWebView && redirectUrl && (
        <WebView
          source={{ uri: redirectUrl }}
          style={styles.webview}
          onShouldStartLoadWithRequest={(request) => {
            const { url } = request;

            if (!handlePaymentCallback(url)) {
              return false;
            }

            // 앱 스킴(카드사/은행/간편결제 앱 전환: supertoss://·ispmobile://·intent:// 등)은
            // 웹뷰 로드 대신 외부앱으로 연다. 없으면 net::ERR_UNKNOWN_URL_SCHEME 로 인증 실패.
            if (isExternalAppScheme(url)) {
              Linking.openURL(url).catch(() => {
                /* 앱 미설치 등 — 무시(사용자 안내는 결제 타임아웃으로 처리) */
              });
              return false;
            }

            // 토스 결제 리다이렉트 허용 호스트만 로드.
            return isAllowedPgHost(url, [...ALLOWED_PG_REDIRECT_HOSTS]);
          }}
          onError={(event) => {
            setState("failed");
            setErrorMessage(event.nativeEvent.description || t("payment.failed"));
          }}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          renderLoading={() => (
            <View style={[styles.center, StyleSheet.absoluteFill]}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          )}
        />
      )}

      {/* Success */}
      {state === "success" && (
        <View style={styles.center}>
          <Text style={{ fontSize: 64 }}>✓</Text>
          <Text style={[typography.h2, { color: colors.success, marginTop: spacing.lg }]}>
            {t("payment.success")}
          </Text>
          {/* 결제 완료 영수증에 금액 표시 — 분쟁 증빙 + 최종 확인(P2-C10) */}
          {paymentAmount > 0 && (
            <Text style={[typography.h3, { color: colors.foreground, marginTop: spacing.sm }]}>
              {formatKRW(paymentAmount)}
            </Text>
          )}
          <Button
            title={t("ticket.myTickets")}
            onPress={handleDone}
            size="xl"
            style={{ marginTop: spacing.xxl, minWidth: 200 }}
          />
        </View>
      )}

      {/* Failed / Cancelled */}
      {state === "failed" && (
        <View style={styles.center}>
          <Text style={{ fontSize: 64 }}>✕</Text>
          <Text style={[typography.h3, { color: colors.destructive, marginTop: spacing.lg }]}>
            {t("payment.failed")}
          </Text>
          {errorMessage && (
            <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.sm, textAlign: "center", paddingHorizontal: spacing.xl }]}>
              {errorMessage}
            </Text>
          )}
          <View style={styles.failActions}>
            <Button
              title={t("payment.retry")}
              onPress={handleRetry}
              size="lg"
              style={{ flex: 1 }}
            />
            <Button
              title={t("common.back")}
              onPress={() => router.back()}
              variant="outline"
              size="lg"
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  webview: {
    flex: 1,
  },
  failActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
});

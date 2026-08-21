import { Component, type ErrorInfo, type ReactNode } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Appearance } from "react-native";
import i18n from "@/i18n";
import { colors, typography, spacing, radius } from "@/config/theme";
import { reportError } from "@/lib/crash-reporting";

function getThemeColors() {
  return colors[Appearance.getColorScheme() === "dark" ? "dark" : "light"];
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary
 * 크래시 시 "다시 시도" 화면 표시. 앱 전체를 감싸서 사용.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (__DEV__) console.error("[ErrorBoundary]", error, info.componentStack);
    reportError(error, { componentStack: info.componentStack ?? "" });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const c = getThemeColors();

      return (
        <View style={[styles.container, { backgroundColor: c.background }]}>
          <Text style={styles.icon}>⚠</Text>
          <Text style={[styles.title, { color: c.foreground }]}>
            {i18n.t("common.error")}
          </Text>
          <Text style={[styles.message, { color: c.mutedForeground }]}>
            {this.state.error?.message ?? ""}
          </Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: c.primary }]}
            onPress={this.handleRetry}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={i18n.t("common.retry")}
          >
            <Text style={[styles.buttonText, { color: c.primaryForeground }]}>
              {i18n.t("common.retry")}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  icon: {
    fontSize: 48,
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    marginBottom: spacing.sm,
  },
  message: {
    ...typography.body,
    textAlign: "center",
    marginBottom: spacing.xl,
  },
  button: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
    minHeight: 48,
    justifyContent: "center",
  },
  buttonText: {
    ...typography.h4,
  },
});

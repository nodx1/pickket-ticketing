import { useCallback, useMemo, useEffect, useState, forwardRef } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, BackHandler } from "react-native";
import BottomSheet, { BottomSheetBackdrop } from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { Button } from "@/components/ui/Button";
import type { EventSearchParams } from "@/config/api";

const CATEGORIES = [
  "CONCERT", "MUSICAL", "SPORTS", "EXHIBITION",
  "FESTIVAL", "THEATER", "FANMEETING", "CLASSIC",
] as const;

const CITIES = [
  "서울", "부산", "대구", "인천", "광주",
  "대전", "울산", "제주",
] as const;

const SORT_OPTIONS = [
  { key: "relevance", labelKey: "search.sortRelevance" },
  { key: "date_asc", labelKey: "search.sortDateAsc" },
  { key: "date_desc", labelKey: "search.sortDateDesc" },
  { key: "price_asc", labelKey: "search.sortPriceAsc" },
  { key: "price_desc", labelKey: "search.sortPriceDesc" },
] as const;

interface Props {
  filters: EventSearchParams;
  onApply: (filters: EventSearchParams) => void;
  onReset: () => void;
}

export const FilterSheet = forwardRef<BottomSheet, Props>(
  function FilterSheet({ filters, onApply, onReset }, ref) {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const snapPoints = useMemo(() => ["70%"], []);
    const [isOpen, setIsOpen] = useState(false);

    // Android 하드웨어 백 버튼: sheet 열려있으면 닫기
    useEffect(() => {
      if (!isOpen) return;
      const handler = BackHandler.addEventListener("hardwareBackPress", () => {
        if (typeof ref === "object" && ref?.current) {
          ref.current.close();
        }
        return true;
      });
      return () => handler.remove();
    }, [isOpen, ref]);

    const renderBackdrop = useCallback(
      (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
      ),
      [],
    );

    const toggleCategory = useCallback(
      (cat: string) => {
        onApply({ ...filters, category: filters.category === cat ? undefined : cat });
      },
      [filters, onApply],
    );

    const toggleCity = useCallback(
      (city: string) => {
        onApply({ ...filters, city: filters.city === city ? undefined : city });
      },
      [filters, onApply],
    );

    const setSort = useCallback(
      (sort: string) => {
        onApply({ ...filters, sort });
      },
      [filters, onApply],
    );

    return (
      <BottomSheet
        ref={ref}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: colors.card }}
        handleIndicatorStyle={{ backgroundColor: colors.mutedForeground }}
        onChange={(index) => setIsOpen(index >= 0)}
      >
        <ScrollView contentContainerStyle={styles.content}>
          {/* Category */}
          <Text style={[typography.h4, { color: colors.foreground }]}>
            {t("home.categories")}
          </Text>
          <View style={styles.chipRow}>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.chip,
                  {
                    backgroundColor: filters.category === cat ? colors.primary : colors.surface,
                    borderColor: filters.category === cat ? colors.primary : colors.border,
                  },
                ]}
                onPress={() => toggleCategory(cat)}
                accessibilityLabel={t(`categories.${cat}`)}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    typography.bodySmall,
                    { color: filters.category === cat ? colors.primaryForeground : colors.foreground },
                  ]}
                >
                  {t(`categories.${cat}`)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* City */}
          <Text style={[typography.h4, { color: colors.foreground, marginTop: spacing.lg }]}>
            {t("search.city")}
          </Text>
          <View style={styles.chipRow}>
            {CITIES.map((city) => (
              <TouchableOpacity
                key={city}
                style={[
                  styles.chip,
                  {
                    backgroundColor: filters.city === city ? colors.primary : colors.surface,
                    borderColor: filters.city === city ? colors.primary : colors.border,
                  },
                ]}
                onPress={() => toggleCity(city)}
                accessibilityLabel={city}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    typography.bodySmall,
                    { color: filters.city === city ? colors.primaryForeground : colors.foreground },
                  ]}
                >
                  {city}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Sort */}
          <Text style={[typography.h4, { color: colors.foreground, marginTop: spacing.lg }]}>
            {t("search.sort")}
          </Text>
          <View style={styles.chipRow}>
            {SORT_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[
                  styles.chip,
                  {
                    backgroundColor: filters.sort === opt.key ? colors.primary : colors.surface,
                    borderColor: filters.sort === opt.key ? colors.primary : colors.border,
                  },
                ]}
                onPress={() => setSort(opt.key)}
                accessibilityLabel={t(opt.labelKey)}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    typography.bodySmall,
                    { color: filters.sort === opt.key ? colors.primaryForeground : colors.foreground },
                  ]}
                >
                  {t(opt.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Reset */}
          <Button
            title={t("search.resetFilters")}
            variant="outline"
            onPress={onReset}
            style={{ marginTop: spacing.xl }}
          />
        </ScrollView>
      </BottomSheet>
    );
  },
);

const styles = StyleSheet.create({
  content: {
    padding: spacing.xl,
    paddingBottom: spacing.xxl * 2,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },
});

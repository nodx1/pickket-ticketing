"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Minus, Plus, X } from "lucide-react";
import { Button, Input } from "@pickket/ui";
import type { CreateABTestData } from "@pickket/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateABTestData) => Promise<void>;
}

interface VariantRow {
  name: string;
  weight: number;
}

export default function CreateExperimentDialog({
  open,
  onClose,
  onSubmit,
}: Props) {
  const t = useTranslations("experiments.createDialog");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [metricKey, setMetricKey] = useState("");
  const [targetPercentage, setTargetPercentage] = useState(100);
  const [variants, setVariants] = useState<VariantRow[]>([
    { name: "control", weight: 50 },
    { name: "variant_a", weight: 50 },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const addVariant = () => {
    if (variants.length >= 10) return;
    const letter = String.fromCharCode(97 + variants.length - 1); // b, c, d ...
    setVariants([...variants, { name: `variant_${letter}`, weight: 50 }]);
  };

  const removeVariant = (idx: number) => {
    if (variants.length <= 2) return;
    setVariants(variants.filter((_, i) => i !== idx));
  };

  const updateVariant = (
    idx: number,
    field: keyof VariantRow,
    value: string | number,
  ) => {
    setVariants(
      variants.map((v, i) => (i === idx ? { ...v, [field]: value } : v)),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (variants.some((v) => !v.name.trim())) return;

    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        metric_key: metricKey.trim() || undefined,
        variants: variants.map((v) => ({
          name: v.name.trim(),
          weight: v.weight,
        })),
        target_audience:
          targetPercentage < 100 ? { percentage: targetPercentage } : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border rounded-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm font-medium mb-1 block">
              {t("nameLabel")} <span className="text-red-500">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="homepage_cta_color"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium mb-1 block">{t("descriptionLabel")}</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
            />
          </div>

          {/* Metric key */}
          <div>
            <label className="text-sm font-medium mb-1 block">{t("metricKeyLabel")}</label>
            <Input
              value={metricKey}
              onChange={(e) => setMetricKey(e.target.value)}
              placeholder="purchase_conversion"
            />
          </div>

          {/* Target percentage */}
          <div>
            <label className="text-sm font-medium mb-1 block">
              {t("targetPercentageLabel", { percentage: targetPercentage ?? 100 })}
            </label>
            <input
              type="range"
              min={1}
              max={100}
              value={targetPercentage}
              onChange={(e) => setTargetPercentage(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          {/* Variants */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">
                {t("variantsLabel")} <span className="text-red-500">*</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addVariant}
                disabled={variants.length >= 10}
              >
                <Plus className="h-3 w-3 mr-1" />
                {t("addVariant")}
              </Button>
            </div>
            <div className="space-y-2">
              {variants.map((v, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={v.name}
                    onChange={(e) => updateVariant(idx, "name", e.target.value)}
                    placeholder={t("variantNamePlaceholder")}
                    className="flex-1"
                    required
                  />
                  <div className="flex items-center gap-1 w-24">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={v.weight}
                      onChange={(e) =>
                        updateVariant(idx, "weight", Number(e.target.value))
                      }
                      className="w-16 text-center"
                    />
                    <span className="text-xs text-muted-foreground">w</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeVariant(idx)}
                    disabled={variants.length <= 2}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("variantsHint")}
            </p>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

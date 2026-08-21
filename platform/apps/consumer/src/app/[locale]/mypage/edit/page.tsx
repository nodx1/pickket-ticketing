"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useForm } from "react-hook-form";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, User, Globe, Clock, Save } from "lucide-react";
import Link from "next/link";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { Textarea } from "@pickket/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { useAuthReady } from "@/providers/AuthProvider";
import { getUserProfile, updateUserProfile } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

interface ProfileFormData {
  name: string;
  phone: string;
  bio: string;
  preferred_language: string;
  timezone: string;
}

const LANGUAGES = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "中文(简体)" },
  { value: "fr", label: "Français" },
];

const TIMEZONES = [
  { value: "Asia/Seoul", label: "서울 (KST, UTC+9)" },
  { value: "Asia/Tokyo", label: "도쿄 (JST, UTC+9)" },
  { value: "Asia/Shanghai", label: "상하이 (CST, UTC+8)" },
  { value: "America/New_York", label: "뉴욕 (EST, UTC-5)" },
  { value: "America/Los_Angeles", label: "로스앤젤레스 (PST, UTC-8)" },
  { value: "Europe/London", label: "런던 (GMT, UTC+0)" },
  { value: "Europe/Paris", label: "파리 (CET, UTC+1)" },
];

export default function ProfileEditPage() {
  const router = useRouter();
  const { user, setAuth, token } = useAuthStore();
  const authReady = useAuthReady();
  const _t = useTranslations("mypage");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ProfileFormData>({
    defaultValues: {
      name: "",
      phone: "",
      bio: "",
      preferred_language: "ko",
      timezone: "Asia/Seoul",
    },
  });

  const selectedLanguage = watch("preferred_language");
  const selectedTimezone = watch("timezone");

  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      router.push("/auth");
      return;
    }

    async function loadProfile() {
      try {
        const res = await getUserProfile();
        const profile = res.data;
        reset({
          name: profile.name || "",
          phone: profile.phone || "",
          bio: profile.bio || "",
          preferred_language: profile.preferred_language || "ko",
          timezone: profile.timezone || "Asia/Seoul",
        });
        setAvatarUrl(profile.avatar_url || null);
      } catch {
        toast.error("프로필을 불러오는데 실패했습니다.");
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [authReady, user, router, reset]);

  const onSubmit = async (data: ProfileFormData) => {
    setSaving(true);
    try {
      const res = await updateUserProfile({
        name: data.name,
        phone: data.phone || undefined,
        bio: data.bio || undefined,
        preferred_language: data.preferred_language,
        timezone: data.timezone,
      });
      const updatedProfile = res.data;
      if (token) {
        setAuth(
          {
            ...user!,
            name: updatedProfile.name,
            phone: updatedProfile.phone,
            bio: updatedProfile.bio,
            avatar_url: updatedProfile.avatar_url,
            preferred_language: updatedProfile.preferred_language,
            timezone: updatedProfile.timezone,
          },
          token,
        );
      }
      toast.success("프로필이 업데이트되었습니다.");
      router.push("/mypage");
    } catch {
      toast.error("프로필 업데이트에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const getInitial = (name: string) => {
    return name ? name.charAt(0).toUpperCase() : "?";
  };

  if (!user) return null;

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6 pt-20">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <div className="h-20 w-20 bg-muted rounded-full animate-pulse" />
            <div className="space-y-2">
              <div className="h-6 w-40 bg-muted rounded animate-pulse" />
              <div className="h-4 w-56 bg-muted rounded animate-pulse" />
            </div>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card rounded-xl border border-border p-4 space-y-3"
            >
              <div className="h-4 bg-muted rounded animate-pulse w-1/4" />
              <div className="h-10 bg-muted rounded animate-pulse w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen bg-background"
    >
      <div className="max-w-7xl mx-auto px-8 pt-24 pb-10">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link href="/mypage">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">프로필 편집</h1>
            <p className="text-sm text-muted-foreground">
              내 정보를 수정합니다
            </p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="max-w-lg mx-auto space-y-6"
        >
          {/* Avatar Section */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col items-center gap-3 py-6"
          >
            <div className="relative">
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt="프로필 사진"
                  width={96}
                  height={96}
                  className="h-24 w-24 rounded-full object-cover ring-4 ring-background shadow-lg"
                />
              ) : (
                <div className="h-24 w-24 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center ring-4 ring-background shadow-lg">
                  <span className="text-3xl font-bold text-white">
                    {getInitial(user.name)}
                  </span>
                </div>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </motion.div>

          {/* Basic Info Section */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-card rounded-2xl border border-border p-5 space-y-5"
          >
            <div className="flex items-center gap-2 mb-1">
              <User className="h-4 w-4 text-primary/70" />
              <h2 className="font-semibold text-foreground">기본 정보</h2>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">이름</Label>
              <Input
                id="name"
                placeholder="이름을 입력하세요"
                {...register("name", {
                  required: "이름은 필수입니다",
                  minLength: {
                    value: 1,
                    message: "이름은 1자 이상이어야 합니다",
                  },
                  maxLength: {
                    value: 100,
                    message: "이름은 100자 이내여야 합니다",
                  },
                })}
              />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">연락처</Label>
              <Input
                id="phone"
                placeholder="010-0000-0000"
                {...register("phone", {
                  maxLength: {
                    value: 20,
                    message: "연락처는 20자 이내여야 합니다",
                  },
                })}
              />
              {errors.phone && (
                <p className="text-xs text-destructive">
                  {errors.phone.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bio">자기소개</Label>
              <Textarea
                id="bio"
                placeholder="간단한 자기소개를 입력하세요"
                rows={3}
                className="resize-none"
                {...register("bio", {
                  maxLength: {
                    value: 500,
                    message: "자기소개는 500자 이내여야 합니다",
                  },
                })}
              />
              {errors.bio && (
                <p className="text-xs text-destructive">{errors.bio.message}</p>
              )}
              <p className="text-xs text-muted-foreground text-right">
                {(watch("bio") || "").length}/500
              </p>
            </div>
          </motion.div>

          {/* Preferences Section */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-card rounded-2xl border border-border p-5 space-y-5"
          >
            <div className="flex items-center gap-2 mb-1">
              <Globe className="h-4 w-4 text-primary/70" />
              <h2 className="font-semibold text-foreground">환경설정</h2>
            </div>

            <div className="space-y-2">
              <Label>언어</Label>
              <Select
                value={selectedLanguage}
                onValueChange={(val) =>
                  setValue("preferred_language", val, { shouldDirty: true })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="언어를 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>시간대</Label>
              <Select
                value={selectedTimezone}
                onValueChange={(val) =>
                  setValue("timezone", val, { shouldDirty: true })
                }
              >
                <SelectTrigger>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <SelectValue placeholder="시간대를 선택하세요" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </motion.div>

          {/* Action Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="flex gap-3 pt-2 pb-8"
          >
            <Link href="/mypage" className="flex-1">
              <Button
                type="button"
                variant="outline"
                className="w-full rounded-xl h-12"
              >
                취소
              </Button>
            </Link>
            <Button
              type="submit"
              disabled={saving || !isDirty}
              className="flex-1 rounded-xl h-12 bg-gradient-to-r from-primary to-primary/70 text-white"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  저장 중...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  저장
                </span>
              )}
            </Button>
          </motion.div>
        </form>
      </div>
    </motion.div>
  );
}

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnimatedProgress } from "@/components/ui/animated-progress";
import { showError, showSuccess } from "@/lib/hooks/useToast";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { formatDateKst } from "@/lib/format";

type VerificationStatus =
  | "unverified"
  | "draft"
  | "pending"
  | "approved"
  | "rejected";

type DocType = "biz_cert" | "bankbook" | "permit";

interface BusinessDocument {
  docType: DocType;
  fileUrl: string;
}

interface BusinessCurrent {
  bizNumber: string | null;
  companyName: string | null;
  repName: string | null;
  bizType: string | null;
  bizItem: string | null;
  address: string | null;
  openedOn: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  authorizedConfirmed: boolean | null;
  maskingConfirmed: boolean | null;
  status: string | null;
  documents: BusinessDocument[] | null;
}

interface VerificationPayload {
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  rejectedReason: string | null;
  current: BusinessCurrent | null;
}

interface FormState {
  bizNumber: string;
  companyName: string;
  repName: string;
  bizType: string;
  bizItem: string;
  address: string;
  openedOn: string;
  bankName: string;
  bankAccount: string;
  bankHolder: string;
  authorizedConfirmed: boolean;
  maskingConfirmed: boolean;
  bizCertUrl: string;
  bankbookUrl: string;
}

const EMPTY_FORM: FormState = {
  bizNumber: "",
  companyName: "",
  repName: "",
  bizType: "",
  bizItem: "",
  address: "",
  openedOn: "",
  bankName: "",
  bankAccount: "",
  bankHolder: "",
  authorizedConfirmed: false,
  maskingConfirmed: false,
  bizCertUrl: "",
  bankbookUrl: "",
};

const BANK_OPTIONS = [
  "KB국민은행",
  "신한은행",
  "우리은행",
  "하나은행",
  "NH농협은행",
  "IBK기업은행",
  "카카오뱅크",
  "케이뱅크",
  "토스뱅크",
  "SC제일은행",
  "부산은행",
  "대구은행",
  "경남은행",
  "광주은행",
  "전북은행",
  "제주은행",
  "새마을금고",
  "우체국",
  "수협은행",
  "산업은행",
];

const STEP_TITLES = ["사업자 정보", "서류 제출", "정산 계좌", "검토 및 제출"];

function currentToForm(current: BusinessCurrent): FormState {
  const docs = current.documents ?? [];
  const bizCert = docs.find((doc) => doc.docType === "biz_cert");
  const bankbook = docs.find((doc) => doc.docType === "bankbook");
  return {
    bizNumber: current.bizNumber ?? "",
    companyName: current.companyName ?? "",
    repName: current.repName ?? "",
    bizType: current.bizType ?? "",
    bizItem: current.bizItem ?? "",
    address: current.address ?? "",
    openedOn: current.openedOn ?? "",
    bankName: current.bankName ?? "",
    bankAccount: current.bankAccount ?? "",
    bankHolder: current.bankHolder ?? "",
    authorizedConfirmed: current.authorizedConfirmed ?? false,
    maskingConfirmed: current.maskingConfirmed ?? false,
    bizCertUrl: bizCert?.fileUrl ?? "",
    bankbookUrl: bankbook?.fileUrl ?? "",
  };
}

function formatBizNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  const parts = [digits.slice(0, 3), digits.slice(3, 5), digits.slice(5, 10)].filter(
    (part) => part.length > 0,
  );
  return parts.join("-");
}

function buildDocuments(form: FormState): BusinessDocument[] {
  const documents: BusinessDocument[] = [];
  if (form.bizCertUrl) documents.push({ docType: "biz_cert", fileUrl: form.bizCertUrl });
  if (form.bankbookUrl) documents.push({ docType: "bankbook", fileUrl: form.bankbookUrl });
  return documents;
}

function toRequestBody(form: FormState, action: "save" | "submit") {
  return {
    action,
    bizNumber: form.bizNumber,
    companyName: form.companyName,
    repName: form.repName,
    bizType: form.bizType,
    bizItem: form.bizItem,
    address: form.address,
    openedOn: form.openedOn,
    bankName: form.bankName,
    bankAccount: form.bankAccount,
    bankHolder: form.bankHolder,
    authorizedConfirmed: form.authorizedConfirmed,
    maskingConfirmed: form.maskingConfirmed,
    documents: buildDocuments(form),
  };
}

export function BusinessVerificationCard() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<VerificationPayload | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchWithRefresh("/api/account/business-verification", {
        credentials: "include",
      });
      const payload = (await response.json()) as {
        data?: VerificationPayload;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        setLoadError(payload.error ?? "사업자 인증 정보를 불러오지 못했습니다");
        return;
      }
      setData(payload.data);
    } catch (err: unknown) {
      setLoadError(
        err instanceof Error ? err.message : "사업자 인증 정보를 불러오지 못했습니다",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openWizard() {
    if (data?.current) {
      setForm(currentToForm(data.current));
    } else {
      setForm(EMPTY_FORM);
    }
    setStep(0);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setStep(0);
  }

  async function persist(action: "save" | "submit"): Promise<boolean> {
    const response = await fetchWithRefresh("/api/account/business-verification", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toRequestBody(form, action)),
    });
    const payload = (await response.json()) as {
      data?: { status: string };
      error?: string;
    };
    if (!response.ok) {
      showError(payload.error ?? "요청을 처리하지 못했습니다");
      return false;
    }
    return true;
  }

  async function handleSaveDraft() {
    setSaving(true);
    try {
      const ok = await persist("save");
      if (ok) showSuccess("임시저장되었습니다");
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "임시저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      // 제출 전 최소 1회 저장으로 최신 상태를 보존한다.
      const saved = await persist("save");
      if (!saved) return;
      const ok = await persist("submit");
      if (!ok) return;
      showSuccess("심사를 접수했습니다");
      closeWizard();
      await load();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "제출에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  const stepValidations: boolean[] = [
    Boolean(
      form.bizNumber.trim() &&
        form.companyName.trim() &&
        form.repName.trim() &&
        form.bizType.trim() &&
        form.bizItem.trim() &&
        form.address.trim() &&
        form.openedOn &&
        form.authorizedConfirmed,
    ),
    Boolean(form.bizCertUrl && form.bankbookUrl && form.maskingConfirmed),
    Boolean(form.bankName.trim() && form.bankAccount.trim() && form.bankHolder.trim()),
    true,
  ];

  const canProceed = stepValidations[step];
  const canSubmit = stepValidations.slice(0, 3).every(Boolean);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-content-subtle">
        <Loader2 className="mr-2 size-5 animate-spin" aria-hidden />
        <span>불러오는 중…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="text-sm text-content-subtle">{loadError}</p>
          <Button variant="secondary" onClick={() => void load()}>
            다시 시도
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (wizardOpen) {
    return (
      <Wizard
        step={step}
        form={form}
        saving={saving}
        submitting={submitting}
        canProceed={canProceed}
        canSubmit={canSubmit}
        onChange={setForm}
        onBack={() => setStep((prev) => Math.max(0, prev - 1))}
        onNext={() => setStep((prev) => Math.min(3, prev + 1))}
        onCancel={closeWizard}
        onSaveDraft={() => void handleSaveDraft()}
        onSubmit={() => void handleSubmit()}
      />
    );
  }

  const status = data?.verificationStatus ?? "unverified";

  if (status === "pending") {
    return <PendingView current={data?.current ?? null} />;
  }
  if (status === "approved") {
    return <ApprovedView current={data?.current ?? null} verifiedAt={data?.verifiedAt ?? null} />;
  }
  if (status === "rejected") {
    return (
      <RejectedView
        reason={data?.rejectedReason ?? null}
        current={data?.current ?? null}
        onEdit={openWizard}
      />
    );
  }
  if (status === "draft") {
    return <DraftView onContinue={openWizard} />;
  }
  return <LandingView onStart={openWizard} />;
}

// ---------- 상태별 뷰 ----------

function LandingView({ onStart }: { onStart: () => void }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/12 text-primary">
          <Building2 className="size-6" aria-hidden />
        </div>
        <CardTitle>사업자 인증</CardTitle>
        <CardDescription>
          유료 판매를 열려면 사업자 인증이 필요해요. 아래 서류를 준비한 뒤 인증을 시작해주세요.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="space-y-3">
          {[
            "사업자등록증 사본",
            "정산 계좌 통장 사본",
            "본인 명의 휴대폰",
          ].map((item) => (
            <li key={item} className="flex items-center gap-3 text-sm text-content-default">
              <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        <Button onClick={onStart}>인증 시작하기</Button>
      </CardContent>
    </Card>
  );
}

function DraftView({ onContinue }: { onContinue: () => void }) {
  return (
    <Card>
      <CardHeader>
        <Badge variant="warning" className="w-fit">
          작성 중
        </Badge>
        <CardTitle>작성 중인 인증 신청이 있어요</CardTitle>
        <CardDescription>
          이전에 입력한 내용을 이어서 작성하고 제출할 수 있어요.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={onContinue}>이어서 작성</Button>
      </CardContent>
    </Card>
  );
}

function PendingView({ current }: { current: BusinessCurrent | null }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          <Badge variant="info">심사 중</Badge>
        </div>
        <CardTitle>심사 중입니다 (영업일 1~2일)</CardTitle>
        <CardDescription>
          제출하신 서류를 확인하고 있어요. 심사 중에는 내용을 수정할 수 없습니다.
        </CardDescription>
      </CardHeader>
      {current && (
        <CardContent>
          <SummaryGrid
            rows={[
              ["상호", current.companyName],
              ["사업자등록번호", current.bizNumber],
              ["대표자명", current.repName],
              ["정산 계좌", accountLabel(current)],
            ]}
          />
        </CardContent>
      )}
    </Card>
  );
}

function ApprovedView({
  current,
  verifiedAt,
}: {
  current: BusinessCurrent | null;
  verifiedAt: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <BadgeCheck className="size-6 text-success" aria-hidden />
          <Badge variant="success">승인 완료</Badge>
        </div>
        <CardTitle>사업자 인증이 완료되었어요</CardTitle>
        <CardDescription>이제 유료 티켓을 발행하고 판매할 수 있어요.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {current && (
          <SummaryGrid
            rows={[
              ["상호", current.companyName],
              ["사업자등록번호", current.bizNumber],
              ["대표자명", current.repName],
              ["업태 / 종목", joinLabel(current.bizType, current.bizItem)],
              ["주소", current.address],
              ["정산 계좌", accountLabel(current)],
              ["승인일", formatDate(verifiedAt)],
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function RejectedView({
  reason,
  current,
  onEdit,
}: {
  reason: string | null;
  current: BusinessCurrent | null;
  onEdit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-6 text-destructive" aria-hidden />
          <Badge variant="destructive">반려됨</Badge>
        </div>
        <CardTitle>인증이 반려되었어요</CardTitle>
        <CardDescription>아래 사유를 확인한 뒤 수정하여 다시 제출해주세요.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="mb-1 font-semibold">반려 사유</p>
          <p>{reason?.trim() ? reason : "관리자에게 반려 사유를 문의해주세요."}</p>
        </div>
        {current && (
          <SummaryGrid
            rows={[
              ["상호", current.companyName],
              ["사업자등록번호", current.bizNumber],
            ]}
          />
        )}
        <Button onClick={onEdit}>수정 후 재제출</Button>
      </CardContent>
    </Card>
  );
}

// ---------- 위저드 ----------

interface WizardProps {
  step: number;
  form: FormState;
  saving: boolean;
  submitting: boolean;
  canProceed: boolean;
  canSubmit: boolean;
  onChange: (updater: (prev: FormState) => FormState) => void;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
}

function Wizard({
  step,
  form,
  saving,
  submitting,
  canProceed,
  canSubmit,
  onChange,
  onBack,
  onNext,
  onCancel,
  onSaveDraft,
  onSubmit,
}: WizardProps) {
  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      onChange((prev) => ({ ...prev, [key]: value }));
    },
    [onChange],
  );

  const progress = ((step + 1) / STEP_TITLES.length) * 100;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-content-subtle">
              {step + 1} / {STEP_TITLES.length} 단계
            </p>
            <CardTitle>{STEP_TITLES[step]}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            aria-label="위저드 닫기"
          >
            <X className="size-5" aria-hidden />
          </Button>
        </div>
        <AnimatedProgress value={progress} className="mt-2" />
      </CardHeader>
      <CardContent className="space-y-6">
        {step === 0 && <StepBusinessInfo form={form} update={update} />}
        {step === 1 && <StepDocuments form={form} update={update} />}
        {step === 2 && <StepBankAccount form={form} update={update} />}
        {step === 3 && <StepReview form={form} />}

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            {step > 0 ? (
              <Button variant="outline" onClick={onBack} disabled={submitting}>
                <ChevronLeft className="size-4" aria-hidden />
                이전
              </Button>
            ) : (
              <Button variant="outline" onClick={onCancel} disabled={submitting}>
                취소
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={onSaveDraft}
              disabled={saving || submitting}
            >
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              임시저장
            </Button>
          </div>
          {step < STEP_TITLES.length - 1 ? (
            <Button onClick={onNext} disabled={!canProceed}>
              다음
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button onClick={onSubmit} disabled={!canSubmit || submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              제출하기
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface StepProps {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

function StepBusinessInfo({ form, update }: StepProps) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FieldWrap label="사업자등록번호" hint="형식: XXX-XX-XXXXX">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              placeholder="000-00-00000"
              value={form.bizNumber}
              onChange={(event) => update("bizNumber", formatBizNumber(event.target.value))}
            />
          )}
        </FieldWrap>
        <FieldWrap label="상호 (법인명)">
          {(id) => (
            <Input
              id={id}
              value={form.companyName}
              onChange={(event) => update("companyName", event.target.value)}
            />
          )}
        </FieldWrap>
        <FieldWrap label="대표자명">
          {(id) => (
            <Input
              id={id}
              value={form.repName}
              onChange={(event) => update("repName", event.target.value)}
            />
          )}
        </FieldWrap>
        <FieldWrap label="개업연월일">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={form.openedOn}
              onChange={(event) => update("openedOn", event.target.value)}
            />
          )}
        </FieldWrap>
        <FieldWrap label="업태">
          {(id) => (
            <Input
              id={id}
              placeholder="예: 서비스"
              value={form.bizType}
              onChange={(event) => update("bizType", event.target.value)}
            />
          )}
        </FieldWrap>
        <FieldWrap label="종목">
          {(id) => (
            <Input
              id={id}
              placeholder="예: 공연기획"
              value={form.bizItem}
              onChange={(event) => update("bizItem", event.target.value)}
            />
          )}
        </FieldWrap>
      </div>
      <FieldWrap label="사업장 주소">
        {(id) => (
          <Input
            id={id}
            value={form.address}
            onChange={(event) => update("address", event.target.value)}
          />
        )}
      </FieldWrap>
      <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-subtle p-4 text-sm text-content-default">
        <Checkbox
          checked={form.authorizedConfirmed}
          onCheckedChange={(checked) => update("authorizedConfirmed", checked === true)}
          aria-label="권한 확인"
          className="mt-0.5"
        />
        <span>본인은 이 사업자의 대표이거나 위임받았습니다.</span>
      </label>
    </div>
  );
}

function StepDocuments({ form, update }: StepProps) {
  return (
    <div className="space-y-5">
      <p className="rounded-lg bg-bg-subtle p-4 text-sm text-content-subtle">
        개인정보(주민등록번호 등)를 가리지 않으면 반려될 수 있어요. 제출한 서류는 심사 기간 동안만 보관됩니다.
      </p>
      <DocumentUpload
        label="사업자등록증"
        uploadType="business-cert"
        value={form.bizCertUrl}
        onChange={(url) => update("bizCertUrl", url)}
      />
      <DocumentUpload
        label="통장 사본"
        uploadType="business-cert"
        value={form.bankbookUrl}
        onChange={(url) => update("bankbookUrl", url)}
      />
      <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-subtle p-4 text-sm text-content-default">
        <Checkbox
          checked={form.maskingConfirmed}
          onCheckedChange={(checked) => update("maskingConfirmed", checked === true)}
          aria-label="개인정보 마스킹 확인"
          className="mt-0.5"
        />
        <span>주민등록번호 등 개인정보를 가렸습니다.</span>
      </label>
    </div>
  );
}

function StepBankAccount({ form, update }: StepProps) {
  const bankId = useId();
  return (
    <div className="space-y-5">
      <p className="rounded-lg bg-bg-subtle p-4 text-sm text-content-subtle">
        예금주는 상호(법인) 또는 대표자명(개인)과 일치해야 합니다.
      </p>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={bankId}>은행</Label>
          <Select
            value={form.bankName || undefined}
            onValueChange={(value) => update("bankName", value)}
          >
            <SelectTrigger id={bankId} aria-label="은행 선택">
              <SelectValue placeholder="은행 선택" />
            </SelectTrigger>
            <SelectContent>
              {BANK_OPTIONS.map((bank) => (
                <SelectItem key={bank} value={bank}>
                  {bank}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <FieldWrap label="예금주">
          {(id) => (
            <Input
              id={id}
              value={form.bankHolder}
              onChange={(event) => update("bankHolder", event.target.value)}
            />
          )}
        </FieldWrap>
      </div>
      <FieldWrap label="계좌번호">
        {(id) => (
          <Input
            id={id}
            inputMode="numeric"
            placeholder="- 없이 숫자만 입력"
            value={form.bankAccount}
            onChange={(event) =>
              update("bankAccount", event.target.value.replace(/[^\d-]/g, ""))
            }
          />
        )}
      </FieldWrap>
    </div>
  );
}

function StepReview({ form }: { form: FormState }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-content-subtle">
        입력하신 내용을 확인한 뒤 제출해주세요. 제출 후에는 심사가 완료될 때까지 수정할 수 없어요.
      </p>
      <SummaryGrid
        rows={[
          ["사업자등록번호", form.bizNumber],
          ["상호", form.companyName],
          ["대표자명", form.repName],
          ["업태 / 종목", joinLabel(form.bizType, form.bizItem)],
          ["주소", form.address],
          ["개업연월일", formatDate(form.openedOn)],
          ["은행", form.bankName],
          ["계좌번호", form.bankAccount],
          ["예금주", form.bankHolder],
        ]}
      />
      <div className="space-y-2">
        <p className="text-sm font-semibold text-content-default">제출 서류</p>
        <div className="flex flex-wrap gap-2">
          <Badge variant={form.bizCertUrl ? "success" : "secondary"}>
            사업자등록증 {form.bizCertUrl ? "첨부됨" : "미첨부"}
          </Badge>
          <Badge variant={form.bankbookUrl ? "success" : "secondary"}>
            통장 사본 {form.bankbookUrl ? "첨부됨" : "미첨부"}
          </Badge>
        </div>
      </div>
    </div>
  );
}

// ---------- 문서 업로드 ----------

function DocumentUpload({
  label,
  uploadType,
  value,
  onChange,
}: {
  label: string;
  uploadType: string;
  value: string;
  onChange: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState("");
  const inputId = useId();

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      showError("이미지(jpg/png) 파일만 업로드할 수 있어요");
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("uploadType", uploadType);
      const response = await fetchWithRefresh("/api/upload", {
        method: "POST",
        credentials: "include",
        body,
      });
      const payload = (await response.json()) as {
        data?: { url: string };
        error?: string;
      };
      if (!response.ok || !payload.data?.url) {
        showError(payload.error ?? "업로드에 실패했습니다");
        return;
      }
      onChange(payload.data.url);
      setFileName(file.name);
      showSuccess(`${label} 업로드 완료`);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "업로드에 실패했습니다");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />
      {value ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <div className="relative size-16 shrink-0 overflow-hidden rounded-md border border-border bg-bg-subtle">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt={`${label} 미리보기`} className="size-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-content-default">
              {fileName || `${label} 첨부됨`}
            </p>
            <div className="mt-1 flex gap-3">
              <button
                type="button"
                className="text-xs font-semibold text-primary hover:underline"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                다시 첨부
              </button>
              <button
                type="button"
                className="text-xs font-semibold text-destructive hover:underline"
                onClick={() => {
                  onChange("");
                  setFileName("");
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border bg-bg-subtle p-4 text-left text-sm text-content-subtle transition-colors hover:border-primary/40 hover:bg-bg-muted disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
          ) : (
            <Upload className="size-5 text-primary" aria-hidden />
          )}
          <span>{uploading ? "업로드 중…" : `${label} 이미지 업로드 (jpg/png)`}</span>
        </button>
      )}
    </div>
  );
}

// ---------- 공용 UI ----------

function FieldWrap({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-content-subtle">{hint}</p>}
    </div>
  );
}

function SummaryGrid({ rows }: { rows: [string, string | null][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs text-content-subtle">{label}</dt>
          <dd className="flex items-center gap-1.5 text-sm text-content-default">
            <FileText className="size-3.5 shrink-0 text-content-subtle" aria-hidden />
            {value?.trim() ? value : "-"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function joinLabel(a: string | null, b: string | null): string {
  return [a, b].filter((part) => part?.trim()).join(" / ");
}

function accountLabel(current: BusinessCurrent): string {
  return joinLabel(current.bankName, current.bankAccount);
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  // KST 고정 — 서버 시간대에 따라 날짜가 밀리지 않게 한다(lib/format 참조).
  return formatDateKst(value, value);
}

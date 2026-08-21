/**
 * Error utilities for extracting structured error codes from API responses.
 *
 * The backend returns errors in the format:
 *   { "code": "ERROR_CODE", "message": "Human-readable message" }
 *
 * This utility extracts the code and allows mapping to i18n keys.
 */

export interface ApiErrorDetail {
  code: string;
  message: string;
}

/**
 * Extract the structured error code from an API error response.
 * Returns null if the error is not in the expected format.
 */
export function extractErrorCode(error: unknown): string | null {
  const detail = (error as { response?: { data?: { detail?: ApiErrorDetail | string } } })
    ?.response?.data?.detail;

  if (typeof detail === "object" && detail !== null && "code" in detail) {
    return (detail as ApiErrorDetail).code;
  }

  return null;
}

/**
 * Extract the human-readable message from an API error response.
 * Falls back to the provided default message.
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: ApiErrorDetail | string } } })
    ?.response?.data?.detail;

  if (typeof detail === "string") {
    return detail;
  }

  if (typeof detail === "object" && detail !== null && "message" in detail) {
    return (detail as ApiErrorDetail).message;
  }

  return fallback;
}

/**
 * Map an API error code to an i18n key in the "errors" namespace.
 * Usage: t(getErrorI18nKey(code)) where t = useTranslations("errors")
 */
export function getErrorI18nKey(code: string | null): string {
  return code ?? "UNKNOWN_ERROR";
}

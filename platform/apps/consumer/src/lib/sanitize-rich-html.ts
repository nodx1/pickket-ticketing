import DOMPurify from "isomorphic-dompurify";

const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

export function sanitizeRichHtml(html: string | null | undefined): string {
  return DOMPurify.sanitize(html ?? "", {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP,
  });
}

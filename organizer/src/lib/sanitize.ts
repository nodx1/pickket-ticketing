const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => htmlEscapes[char] ?? char);
}

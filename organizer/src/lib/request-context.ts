import crypto from "node:crypto";

export function getOrCreateRequestId(headers: Headers) {
  return headers.get("x-request-id") ?? crypto.randomUUID();
}

export function getRequestContext(request: Request) {
  return {
    requestId: getOrCreateRequestId(request.headers),
    method: request.method,
    path: new URL(request.url).pathname,
  };
}

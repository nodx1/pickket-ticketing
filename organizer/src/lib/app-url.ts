function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

export function getAppOrigin(request?: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  if (!request) {
    return "";
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const fallbackUrl = new URL(request.url);
    const forwardedProto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
      fallbackUrl.protocol.replace(/:$/, "");
    return trimTrailingSlash(`${forwardedProto}://${forwardedHost}`);
  }

  return trimTrailingSlash(new URL(request.url).origin);
}

import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export default getRequestConfig(async () => {
  let locale = "ko";
  try {
    const cookieStore = await cookies();
    const localeCookie = cookieStore.get("locale");
    if (localeCookie?.value && ["ko", "en"].includes(localeCookie.value)) {
      locale = localeCookie.value;
    }
  } catch {}

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});

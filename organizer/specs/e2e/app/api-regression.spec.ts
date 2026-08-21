import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

type SuccessResponse<T> = {
  success: boolean;
  data: T;
};

type EventSettingsPayload = {
  title: string;
  slug: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  venueAddress: string | null;
  eventType: string;
  ageRating: string;
  maxAttendees: number | null;
  isOnline: boolean;
  status: "draft" | "live" | "paused" | "archived";
  heroImageUrl?: string | null;
  transportInfo?: string | null;
  parkingInfo?: string | null;
};

test("인증된 운영 API 핵심 회귀를 점검한다", async ({ request }) => {
  await loginAsDemoApi(request);

  const meResponse = await request.get("/api/auth/me");
  expect(meResponse.ok()).toBeTruthy();
  const mePayload = (await meResponse.json()) as SuccessResponse<{ email: string; role: string }>;
  expect(mePayload.data.email).toBe("demo@pickket.kr");
  expect(mePayload.data.role).toBe("owner");

  const { firstEventId, liveEventSlug } = await getSeededEventIds(request);

  const dashboardResponse = await request.get(`/api/events/${firstEventId}/dashboard`);
  expect(dashboardResponse.ok()).toBeTruthy();
  const dashboardPayload = (await dashboardResponse.json()) as SuccessResponse<{
    totalOrders: number;
    totalAttendees: number;
    totalRevenue: number;
    checkedInCount: number;
    dailySales: Array<{ date: string; amount: number; count: number }>;
    productSales: Array<{ name: string; sold: number; revenue: number }>;
  }>;
  expect(dashboardPayload.success).toBeTruthy();
  expect(Array.isArray(dashboardPayload.data.dailySales)).toBeTruthy();
  expect(Array.isArray(dashboardPayload.data.productSales)).toBeTruthy();

  const settingsResponse = await request.get(`/api/events/${firstEventId}/settings`);
  expect(settingsResponse.ok()).toBeTruthy();
  const settingsPayload = (await settingsResponse.json()) as SuccessResponse<EventSettingsPayload>;

  const patchResponse = await request.patch(`/api/events/${firstEventId}/settings`, {
    data: {
      ...settingsPayload.data,
      maxAttendees:
        settingsPayload.data.maxAttendees === null
          ? ""
          : String(settingsPayload.data.maxAttendees),
      description: settingsPayload.data.description ?? "",
      venueName: settingsPayload.data.venueName ?? "",
      venueAddress: settingsPayload.data.venueAddress ?? "",
      heroImageUrl: settingsPayload.data.heroImageUrl ?? "",
      transportInfo: settingsPayload.data.transportInfo ?? "",
      parkingInfo: settingsPayload.data.parkingInfo ?? "",
    },
  });
  expect(patchResponse.ok()).toBeTruthy();

  const accountResponse = await request.get("/api/account/settings");
  expect(accountResponse.ok()).toBeTruthy();
  const accountPayload = (await accountResponse.json()) as SuccessResponse<{
    name: string;
    timezone: string;
    currency: string;
  }>;

  const accountPatchResponse = await request.patch("/api/account/settings", {
    data: accountPayload.data,
  });
  expect(accountPatchResponse.ok()).toBeTruthy();

  for (const type of ["sales", "products", "promo", "attendees"]) {
    const reportResponse = await request.get(`/api/events/${firstEventId}/reports?type=${type}`);
    expect(reportResponse.ok(), type).toBeTruthy();
  }

  for (const exportPath of [
    `/api/events/${firstEventId}/orders/export`,
    `/api/events/${firstEventId}/attendees/export`,
    `/api/events/${firstEventId}/reports/export?type=sales`,
    `/api/events/${firstEventId}/check-in/export`,
  ]) {
    const exportResponse = await request.get(exportPath);
    expect(exportResponse.ok(), exportPath).toBeTruthy();
    expect(exportResponse.headers()["content-type"]).toContain("text/csv");
  }

  const notificationsResponse = await request.get("/api/notifications");
  expect(notificationsResponse.ok()).toBeTruthy();

  const membersResponse = await request.get("/api/account/members");
  expect(membersResponse.ok()).toBeTruthy();

  const publicEventResponse = await request.get(`/api/public/events/${liveEventSlug}`);
  expect(publicEventResponse.ok()).toBeTruthy();
});

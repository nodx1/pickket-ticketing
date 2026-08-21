/**
 * Phase E.1 — location-notify 단위 테스트
 */
const mockGetForegroundPermissionsAsync = jest.fn();
const mockRequestForegroundPermissionsAsync = jest.fn();
const mockGetCurrentPositionAsync = jest.fn();

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: (...a: unknown[]) => mockGetForegroundPermissionsAsync(...a),
  requestForegroundPermissionsAsync: (...a: unknown[]) => mockRequestForegroundPermissionsAsync(...a),
  getCurrentPositionAsync: (...a: unknown[]) => mockGetCurrentPositionAsync(...a),
  Accuracy: { Balanced: 3 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
}));

const mockCheckGeofence = jest.fn();
jest.mock("@/config/api", () => ({
  checkGeofence: (...a: unknown[]) => mockCheckGeofence(...a),
  createGeofence: jest.fn(),
  deleteGeofence: jest.fn(),
  listMyGeofences: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/crash-reporting", () => ({
  reportError: jest.fn(),
}));

import {
  requestLocationPermission,
  getCurrentPosition,
  runGeofenceCheck,
} from "@/lib/location-notify";

beforeEach(() => {
  mockGetForegroundPermissionsAsync.mockReset();
  mockRequestForegroundPermissionsAsync.mockReset();
  mockGetCurrentPositionAsync.mockReset();
  mockCheckGeofence.mockReset();
});

describe("requestLocationPermission", () => {
  it("returns true if already granted", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    await expect(requestLocationPermission()).resolves.toBe(true);
    expect(mockRequestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("requests permission if not yet determined", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "undetermined", canAskAgain: true });
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: "granted" });
    await expect(requestLocationPermission()).resolves.toBe(true);
  });

  it("returns false when canAskAgain is false and not granted", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: false });
    await expect(requestLocationPermission()).resolves.toBe(false);
    expect(mockRequestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("getCurrentPosition", () => {
  it("returns null when permission denied", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: false });
    await expect(getCurrentPosition()).resolves.toBeNull();
  });

  it("returns coords when granted", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    mockGetCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 37.5, longitude: 127.0 },
    });
    await expect(getCurrentPosition()).resolves.toEqual({ lat: 37.5, lng: 127.0 });
  });
});

describe("runGeofenceCheck", () => {
  it("returns empty when no location", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "denied", canAskAgain: false });
    await expect(runGeofenceCheck()).resolves.toEqual([]);
    expect(mockCheckGeofence).not.toHaveBeenCalled();
  });

  it("calls checkGeofence with coords", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    mockGetCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 37.5, longitude: 127.0 },
    });
    mockCheckGeofence.mockResolvedValue([
      { subscription_id: "s1", event_id: "e1", distance_m: 500 },
    ]);
    const result = await runGeofenceCheck();
    expect(mockCheckGeofence).toHaveBeenCalledWith(37.5, 127.0);
    expect(result).toHaveLength(1);
  });

  it("returns empty on API error", async () => {
    mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    mockGetCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 37.5, longitude: 127.0 },
    });
    mockCheckGeofence.mockRejectedValue(new Error("network"));
    await expect(runGeofenceCheck()).resolves.toEqual([]);
  });
});

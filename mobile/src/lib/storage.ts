/**
 * 모바일 Storage 어댑터
 *
 * - JWT 토큰 → SecureStore (OS 암호화: iOS Keychain / Android Keystore)
 * - 일반 데이터 → AsyncStorage (설정, 캐시, 온보딩 플래그 등)
 *
 * @pickket/lib의 StorageAdapter 인터페이스 구현
 */
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 비동기 Storage API
 *
 * 모바일은 SecureStore/AsyncStorage 모두 비동기.
 * @pickket/lib의 동기 StorageAdapter는 v2 모노레포 연결 시
 * configureStorage()로 연결 예정 (Week 2+ metro.config 활성화 후).
 */
export const storage = {
  async getSecure(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      return null;
    }
  },

  async setSecure(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  },

  async removeSecure(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  },

  async get(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      return null;
    }
  },

  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },

  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },

  /** 토큰 전용 헬퍼 */
  async getAccessToken(): Promise<string | null> {
    return this.getSecure("access_token");
  },

  async setAccessToken(token: string): Promise<void> {
    await this.setSecure("access_token", token);
  },

  async getRefreshToken(): Promise<string | null> {
    return this.getSecure("refresh_token");
  },

  async setRefreshToken(token: string): Promise<void> {
    await this.setSecure("refresh_token", token);
  },

  /** 인증 데이터 전체 삭제 */
  async clearAuth(): Promise<void> {
    await Promise.all([
      this.removeSecure("access_token"),
      this.removeSecure("refresh_token"),
      this.removeSecure("pickket_token"),
      this.removeSecure("auth_token"),
      this.remove("pickket_user"),
      this.remove("auth_user"),
    ]);
  },
};

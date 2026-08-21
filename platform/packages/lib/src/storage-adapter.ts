/**
 * Storage Adapter — platform-agnostic key-value persistence.
 *
 * Default implementation wraps browser `sessionStorage` with SSR guards.
 * Mobile (Expo/RN) can swap in AsyncStorage or SecureStore via
 * `configureStorage()`.
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Default web implementation
const webStorage: StorageAdapter = {
  getItem: (key) => {
    if (typeof window === "undefined") return null;
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* noop — quota or privacy mode */
    }
  },
  removeItem: (key) => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

let _storage: StorageAdapter = webStorage;

export function configureStorage(adapter: StorageAdapter): void {
  _storage = adapter;
}

export function getStorage(): StorageAdapter {
  return _storage;
}

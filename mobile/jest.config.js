/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/ios",
  setupFiles: ["./jest.setup.js"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler|react-native-screens|react-native-safe-area-context|react-native-pager-view|@gorhom/bottom-sheet|react-native-qrcode-svg|react-native-webview|@tanstack/react-query|zustand|i18next|react-i18next|expo-image|expo-router|expo-linking|expo-constants|expo-device|expo-secure-store|expo-localization|expo-notifications|expo-local-authentication|expo-screen-capture|expo-application|expo-web-browser|expo-auth-session|expo-crypto|expo-font|expo-splash-screen|expo-status-bar|@react-native-async-storage/async-storage|@react-native-community/netinfo)",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@pickket/lib/api$": "<rootDir>/../platform/packages/lib/src/api.ts",
    "^@pickket/lib/(.*)$": "<rootDir>/../platform/packages/lib/src/$1",
    "^@pickket/store/(.*)$": "<rootDir>/../platform/packages/store/src/$1",
  },
  collectCoverageFrom: [
    "src/hooks/**/*.{ts,tsx}",
    "src/lib/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/i18n/locales/**",
  ],
  coverageThreshold: {
    global: {
      branches: 20,
      functions: 40,
      lines: 30,
      statements: 30,
    },
  },
  testMatch: [
    "<rootDir>/src/__tests__/**/*.test.{ts,tsx}",
  ],
};

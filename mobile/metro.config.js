const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// v3 모노레포 공유 패키지 연결 (platform/packages/{lib,store})
// 주의: @pickket/lib 의 barrel import (`@pickket/lib`) 는 env.ts 에서 process.env 를
// 직접 참조하므로 RN 런타임 폭발함. 반드시 deep import (`@pickket/lib/api`) 만 사용.
// ESLint 규칙 no-restricted-imports 로 barrel import 차단.
const platformRoot = path.resolve(__dirname, "../platform");
config.watchFolders = [
  path.resolve(platformRoot, "packages/lib"),
  path.resolve(platformRoot, "packages/store"),
];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(platformRoot, "packages/lib/node_modules"),
  path.resolve(platformRoot, "packages/store/node_modules"),
  path.resolve(platformRoot, "node_modules"),
];

module.exports = config;

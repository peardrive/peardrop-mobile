/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/?(*.)+(spec|test).ts"],
  moduleFileExtensions: ["ts", "tsx", "js"],
  // We only test pure RN-free modules here for now. If a test needs
  // React Native it should use a separate project/config.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react", esModuleInterop: true, strict: false } }],
  },
  collectCoverageFrom: ["src/lib/**/*.ts"],
};

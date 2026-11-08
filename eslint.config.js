const expoConfig = require("eslint-config-expo/flat");

module.exports = [
  ...expoConfig,
  {
    ignores: [
      "app/app.bundle.mjs",
      "node_modules/**",
      "android/**",
      "ios/**",
      ".expo/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/exhaustive-deps": "warn",
      "import/no-unresolved": "off",
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "import/no-unresolved": "off",
    },
  },
  {
    // Bare worklet globals, so lint does not flag real references.
    files: ["backend/**/*.mjs"],
    languageOptions: {
      globals: {
        Bare: "readonly",
        BareKit: "readonly",
      },
    },
  },
  {
    // scripts/*.mjs and the engine harness run in plain Node, so Node globals apply.
    files: [
      "scripts/**/*.{js,mjs,cjs}",
      "backend/__poc__/**/*.{js,mjs,cjs}",
      "agent-pack/fix-2026-09/harness/**/*.{js,mjs,cjs}",
      "agent-pack/desktop-2026-11/harness/**/*.{js,mjs,cjs}",
      "agent-pack/engine-2026-11/harness/**/*.{js,mjs,cjs}",
      "agent-pack/parity-2026-11/harness/**/*.{js,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
];

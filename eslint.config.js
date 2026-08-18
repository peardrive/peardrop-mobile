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
    // backend/*.mjs runs inside the Bare worklet and has access to Bare
    // runtime globals (`Bare`, `BareKit`) that aren't in the browser/Node
    // globals list. Declare them here so lint doesn't flag real references.
    files: ["backend/**/*.mjs"],
    languageOptions: {
      globals: {
        Bare: "readonly",
        BareKit: "readonly",
      },
    },
  },
  {
    // scripts/*.mjs runs in plain Node (not React Native, not Bare), so
    // Node's built-in globals apply.
    files: ["scripts/**/*.{js,mjs,cjs}", "backend/__poc__/**/*.{js,mjs,cjs}"],
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

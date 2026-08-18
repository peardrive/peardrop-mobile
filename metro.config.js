const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro only bundles a fixed list of asset extensions by default. The demo
// ships plain-text and markdown files that need to be bundled as assets
// (not parsed as source), so register them here. Adding `mjs` to
// sourceExts so our `app/app.bundle.mjs` import keeps working.
config.resolver.assetExts.push("txt", "md", "pdf");

module.exports = config;

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro bundles a fixed asset-extension list; the demo's text and markdown must be assets, not
// source. `mjs` in sourceExts keeps the app/app.bundle.mjs import working.
config.resolver.assetExts.push("txt", "md", "pdf");

module.exports = config;

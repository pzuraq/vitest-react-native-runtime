---
'vitest-mobile': patch
---

Add `metro.babelPlugins` option to inject extra Babel plugins into Metro's transform pipeline.

Native modules like `react-native-reanimated` require compile-time Babel transforms (e.g. worklet directives) that Metro won't apply unless the plugin is explicitly wired in. Previously, users had no way to add these — worklet transforms were silently skipped in both watch mode and pre-built bundles.

**New option: `metro.babelPlugins`.**

```ts
nativePlugin({
  harness: { nativeModules: ['react-native-reanimated'] },
  metro: { babelPlugins: ['react-native-reanimated/plugin'] },
})
```

Plugins are resolved from the harness project's `node_modules` and injected into the generated Metro transformer shim. They run before vitest-mobile's own plugins so worklet transforms etc. are applied before the test wrapper inspects the output. Works in both live Metro (watch mode) and `bundle` pre-builds.

**Auto-injection for known modules.** When a native module listed in `harness.nativeModules` has a well-known companion Babel plugin (currently just `react-native-reanimated` → `react-native-reanimated/plugin`), the harness builder automatically adds it to `babel.config.js` during `bootstrap`.

**CLI plumbing.** The `bundle` command now reads `metro.babelPlugins` from the vitest config and passes them through to the bundler, so pre-built bundles match live-Metro output.

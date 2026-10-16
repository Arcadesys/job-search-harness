// Packages the staged app in dist/app (npm run desktop:stage) for macOS, Windows and Linux.
// Signing turns on by itself when the release workflow has the secrets; see docs/desktop-release.md.
const { devDependencies } = require('./package.json');

const signMac = Boolean(process.env.CSC_LINK);
const notarize = signMac && Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID);

module.exports = {
  appId: 'me.thearcades.jobsearchharness',
  productName: 'Job Search Harness',
  electronVersion: devDependencies.electron,
  directories: { app: 'dist/app', output: 'release', buildResources: 'assets/icons' },
  icon: 'assets/icons/icon.png',
  // PGlite reads its WebAssembly and data files from disk.
  asarUnpack: ['node_modules/@electric-sql/pglite/**'],
  artifactName: 'Job-Search-Harness-${version}-${os}-${arch}.${ext}',
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    identity: signMac ? undefined : null,
    notarize,
  },
  dmg: { title: 'Job Search Harness' },
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, shortcutName: 'Job Search Harness' },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    category: 'Office',
    syncDesktopName: true,
    maintainer: 'Job Search Harness contributors',
    synopsis: 'A private job-search workspace for your AI assistant',
  },
  publish: { provider: 'github', releaseType: 'draft' },
};

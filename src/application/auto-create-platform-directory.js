// Public, non-sensitive platform directory projection. It deliberately
// excludes selectors, patterns and browser-flow implementation details.
function listPlatformDirectory(platforms) {
  return (platforms || []).map(({ id, label, keyHint, defaultKeyName, groupHint, mode, permissionNote, keyLimits }) => ({
    id, label, keyHint, ...(defaultKeyName ? { defaultKeyName } : {}), groupHint, mode,
    ...(permissionNote ? { permissionNote } : {}), ...(keyLimits ? { keyLimits } : {}),
  }));
}
function platformMap(platforms) {
  return new Map((platforms || []).map(platform => [platform.id, platform]));
}
module.exports = { listPlatformDirectory, platformMap };

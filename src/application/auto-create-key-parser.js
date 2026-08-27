function createAutoCreateKeyParser({ credentialPairPlatforms, serializeCredentialPair, parseCredentialPairText, isAssetData }) {
  return function keyFromText(text, platform) {
    const platformId = typeof platform === 'string' ? platform : platform?.id;
    if (credentialPairPlatforms.has(platformId)) return serializeCredentialPair(parseCredentialPairText(text));
    for (const source of platform.keyPatterns || []) {
      const match = String(text || '').match(new RegExp(source));
      if (match && !isAssetData(match[0])) return match[0];
    }
    return null;
  };
}

module.exports = { createAutoCreateKeyParser };

// Pure and fail-closed action selection. DOM probing is performed by runtime
// adapters; this module only ranks already-described candidates.
const STRONG = ['create api key', 'create key', 'add', 'new api key', '创建 api 密钥', '新建 api key', '确定'];
const GENERIC = ['create', 'new', '创建', '新建'];
const REJECT = ['delete', 'remove', 'revoke', 'reset', 'regenerate', '删除', '移除', '撤销', '重置', '重新生成'];
const THRESHOLD = 70;
const MARGIN = 10;

function normalizeActionText(text) {
  return String(text == null ? '' : text).replace(/[\s\u3000]+/g, ' ').trim().toLowerCase();
}
function textHasPhrase(source, phrase) {
  if (!source || !phrase) return false;
  if (/^[\u4e00-\u9fff]/.test(phrase)) return source.includes(phrase);
  return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source);
}
function phraseMatchStrength(source, phrase) {
  return !source || !phrase ? 0 : (source === phrase ? 2 : (source.includes(phrase) ? 1 : 0));
}
function scoreActionCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object' || candidate.disabled || candidate.visible === false) return 0;
  const phrases = Array.isArray(options.phrases) && options.phrases.length ? options.phrases : STRONG;
  const sources = [candidate.text, candidate.ariaLabel, candidate.title].map(normalizeActionText);
  if (REJECT.some(phrase => sources.some(source => source && textHasPhrase(source, phrase)))) return 0;
  const inScope = Boolean(candidate.inVerifiedScope || candidate.selectorMatch);
  let score = 0;
  for (const phrase of phrases) {
    const normalized = normalizeActionText(phrase);
    const generic = GENERIC.includes(normalized);
    if (generic && !(options.allowGenericInsideScope && inScope)) continue;
    for (let index = 0; index < sources.length; index += 1) {
      const strength = phraseMatchStrength(sources[index], normalized);
      if (!strength) continue;
      const base = generic ? 85 : 100;
      score = Math.max(score, (strength === 2 ? base : base - 25) * (index === 0 ? 1 : 0.75));
    }
  }
  const hadPhrase = score > 0;
  if (!hadPhrase && candidate.selectorMatch) score = 90;
  if (hadPhrase && candidate.selectorMatch) score += 12;
  if (score > 0 && options.belowNameInputBonus && candidate.belowNameInput) score += 10;
  return Math.round(score);
}
function descriptorFingerprint(candidate) {
  return [candidate.text, candidate.ariaLabel, candidate.title].map(normalizeActionText).join('|');
}
function resolveActionCandidate(candidates, options = {}) {
  if (!Array.isArray(candidates)) return null;
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : THRESHOLD;
  const margin = Number.isFinite(Number(options.margin)) ? Number(options.margin) : MARGIN;
  const ranked = candidates.map((candidate, index) => ({ candidate, index, score: scoreActionCandidate(candidate, options) }))
    .filter(entry => entry.score >= threshold).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < margin)) return null;
  return ranked[0].candidate;
}
module.exports = { normalizeActionText, textHasPhrase, phraseMatchStrength, scoreActionCandidate, descriptorFingerprint, resolveActionCandidate };

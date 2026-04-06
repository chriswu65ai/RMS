export type WebSearchRoutingDecision = {
  shouldSearch: boolean;
  reason: 'explicit_no_web' | 'explicit_web' | 'recency_or_factual_or_listing' | 'conceptual_or_opinion_or_brainstorm' | 'default_off';
};

const EXPLICIT_NO_WEB_PATTERNS = [
  /\b(?:do not|don't|dont|no|without|avoid|skip)\b[^.!?\n]{0,80}\b(?:web|internet|online|search|lookup|look up|browse|google)\b/i,
  /\b(?:no web lookup|no online lookup|without browsing|don't browse)\b/i,
];

const EXPLICIT_WEB_PATTERNS = [
  /\b(?:search|look up|lookup|browse|check)\b[^.!?\n]{0,60}\b(?:web|internet|online|sources?|news)\b/i,
  /\b(?:find|show|give)\b[^.!?\n]{0,60}\b(?:latest|recent|top stories|current facts?)\b/i,
];

const RECENCY_FACTUAL_LISTING_PATTERNS = [
  /\b(?:latest|recent|newest|today|current|up[- ]to[- ]date|this week|this month)\b/i,
  /\b(?:top stories|headlines|breaking news|market news|price today|earnings this quarter)\b/i,
  /\b(?:facts?|statistics?|numbers?|list\s+of|rank(?:ing)?|best\s+\d+|top\s+\d+)\b/i,
];

const CONCEPTUAL_OPINION_PATTERNS = [
  /\b(?:brainstorm|idea(?:s)?|creative|opinion|take|thoughts?)\b/i,
  /\b(?:explain|concept|theory|principle|framework|trade-?offs?)\b/i,
  /\b(?:pros? and cons?|should i|what do you think|philosoph(?:y|ical))\b/i,
];

const CITATION_REQUEST_PATTERNS = [
  /\b(?:with|include|add|show|give)\b[^.!?\n]{0,40}\b(?:citations?|references?|sources?)\b/i,
  /\b(?:cite|cited|citation)\b/i,
  /\b(?:source\s+links?|link\s+sources?)\b/i,
];

const matchesAny = (text: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));

export const decideWebSearchRouting = (inputText: string): WebSearchRoutingDecision => {
  if (matchesAny(inputText, EXPLICIT_NO_WEB_PATTERNS)) {
    return { shouldSearch: false, reason: 'explicit_no_web' };
  }
  if (matchesAny(inputText, EXPLICIT_WEB_PATTERNS)) {
    return { shouldSearch: true, reason: 'explicit_web' };
  }
  if (matchesAny(inputText, RECENCY_FACTUAL_LISTING_PATTERNS)) {
    return { shouldSearch: true, reason: 'recency_or_factual_or_listing' };
  }
  if (matchesAny(inputText, CONCEPTUAL_OPINION_PATTERNS)) {
    return { shouldSearch: false, reason: 'conceptual_or_opinion_or_brainstorm' };
  }
  return { shouldSearch: false, reason: 'default_off' };
};

export const shouldRenderCitationsForChatPrompt = (inputText: string): boolean => matchesAny(inputText, CITATION_REQUEST_PATTERNS);

import type { SearchResult } from '../searchProviders';

type CitationProcessInput = {
  outputText: string;
  sources: SearchResult[];
  sourceCitationEnabled: boolean;
  retryCanonicalize?: (prompt: string) => Promise<string>;
};

type CitationProcessOutput = {
  outputText: string;
  normalizedText: string;
  citationIndices: number[];
  retryUsed: boolean;
};

const SUPERSCRIPT_DIGIT_MAP: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
};

const SUPERSCRIPT_DIGITS = Object.keys(SUPERSCRIPT_DIGIT_MAP).join('');
const CITATION_COLUMN_HEADER_PATTERN = /\b(?:citation|citations|source|sources|reference|references|ref|refs)\b/i;

const stripRenderedCitationSections = (text: string): string => {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized
    .replace(/\n{0,2}(?:#{1,6}\s*)?(?:Sources|References)\s*:?\s*\n[\s\S]*$/im, '')
    .trimEnd();
};

const normalizeCitationVariants = (text: string): string => {
  let normalized = text;
  normalized = normalized.replace(/【\s*(\d+)\s*】/g, '[$1]');
  normalized = normalized.replace(/［\s*(\d+)\s*］/g, '[$1]');
  normalized = normalized.replace(/\((\d+)\)/g, '[$1]');
  normalized = normalized.replace(/\b(?:source|sources|ref|reference)\s*#?\s*(\d+)\b/gi, '[$1]');
  normalized = normalized.replace(new RegExp(`([${SUPERSCRIPT_DIGITS}]+)`, 'g'), (match) => {
    const numeric = match.split('').map((char) => SUPERSCRIPT_DIGIT_MAP[char] ?? '').join('');
    return numeric ? `[${numeric}]` : match;
  });
  normalized = normalized.replace(/\[(\d+)\s*,\s*(\d+)\]/g, '[$1][$2]');
  return normalized;
};

const collectCitationOccurrences = (text: string): Array<{ index: number; start: number; end: number }> => {
  const occurrences: Array<{ index: number; start: number; end: number }> = [];
  const regex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const index = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(index)) continue;
    occurrences.push({ index, start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
};

const mapCitationIndicesByAppearance = (text: string) => {
  const occurrences = collectCitationOccurrences(text);
  const map = new Map<number, number>();
  let next = 1;
  for (const occurrence of occurrences) {
    if (!map.has(occurrence.index)) {
      map.set(occurrence.index, next);
      next += 1;
    }
  }

  const mappedText = text.replace(/\[(\d+)\]/g, (_match, indexLike: string) => {
    const index = Number.parseInt(indexLike, 10);
    const mapped = map.get(index);
    return typeof mapped === 'number' ? `[${mapped}]` : _match;
  });

  const reverseMap = new Map<number, number>();
  for (const [original, mapped] of Array.from(map.entries())) {
    reverseMap.set(mapped, original);
  }

  return { mappedText, originalByMappedIndex: reverseMap };
};

const validateCitationIndices = (text: string, originalByMappedIndex: Map<number, number>, sourceCount: number) => {
  const invalidMappedIndices = new Set<number>();
  const referencedMappedIndices = new Set<number>();
  for (const { index: mappedIndex } of collectCitationOccurrences(text)) {
    referencedMappedIndices.add(mappedIndex);
    const original = originalByMappedIndex.get(mappedIndex);
    if (typeof original !== 'number' || original < 1 || original > sourceCount) {
      invalidMappedIndices.add(mappedIndex);
    }
  }

  return {
    isValid: invalidMappedIndices.size === 0,
    invalidMappedIndices,
    referencedMappedIndices,
  };
};

const appendLackCitationForUnsupportedSpans = (text: string, invalidMappedIndices: Set<number>): string => {
  if (invalidMappedIndices.size === 0) return text;
  return text.replace(/\[(\d+)\]/g, (match, indexLike: string) => {
    const index = Number.parseInt(indexLike, 10);
    if (invalidMappedIndices.has(index)) {
      return `${match}[lack citation]`;
    }
    return match;
  });
};

const buildSourceAppendix = (sources: SearchResult[], referencedOriginalIndices: Set<number>): string => {
  if (referencedOriginalIndices.size === 0) return '';
  const lines = Array.from(referencedOriginalIndices)
    .sort((a, b) => a - b)
    .map((originalIndex) => {
      const source = sources[originalIndex - 1];
      if (!source) return null;
      const label = source.title.trim() || source.url;
      return `[${originalIndex}] [${label}](${source.url})`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return '';
  return `\n\nSources\n${lines.join('\n')}`;
};

const countCitationArtifacts = (text: string): number => {
  const markerPatterns = [
    /\[\d+\]/g,
    /【\s*\d+\s*】/g,
    /［\s*\d+\s*］/g,
    new RegExp(`[${SUPERSCRIPT_DIGITS}]`, 'g'),
    /\b(?:source|sources|reference|references|ref|refs)\s*#?\s*\d+\b/gi,
  ];
  return markerPatterns.reduce((count, pattern) => count + (text.match(pattern)?.length ?? 0), 0);
};

const hasCitationTableArtifacts = (text: string): boolean => {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = lines[i]?.trim() ?? '';
    const separator = lines[i + 1]?.trim() ?? '';
    if (!header.startsWith('|') || !separator.startsWith('|')) continue;
    if (!/\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?/.test(separator)) continue;
    if (CITATION_COLUMN_HEADER_PATTERN.test(header)) return true;
  }
  return false;
};

const lightweightCleanupOff = (text: string): string => stripRenderedCitationSections(text);

const shouldRewriteCitationArtifacts = (originalText: string, cleanedText: string): boolean => {
  const hasSourceSectionHeader = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:Sources|References)\s*:?\s*(?:\n|$)/i.test(originalText);
  const hasTableRefColumns = hasCitationTableArtifacts(originalText) || hasCitationTableArtifacts(cleanedText);
  const markerCount = countCitationArtifacts(cleanedText);
  const wordCount = cleanedText.trim().split(/\s+/).filter(Boolean).length;
  const hasHighMarkerDensity = markerCount >= 4 && markerCount / Math.max(1, wordCount) >= 0.08;
  const hasDanglingArtifacts =
    /(?:^|\n)\s*(?:\[(?:\d+)\]\s*){1,}\s*$/m.test(cleanedText)
    || /(?:^|\n)\s*.+?(?:\[\d+\]\s*){2,}$/m.test(cleanedText)
    || /(?:^|\n)\s*[-*]?\s*(?:source|sources|reference|references)\s*[:\-]/i.test(cleanedText);

  return hasSourceSectionHeader || hasTableRefColumns || hasHighMarkerDensity || hasDanglingArtifacts;
};

const removeCitationColumnsFromMarkdownTables = (text: string): string => {
  const lines = text.split('\n');
  const output: string[] = [];

  const parseRow = (row: string): string[] => row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? '';
    const separator = lines[i + 1] ?? '';
    const looksLikeTable =
      header.trim().startsWith('|')
      && separator.trim().startsWith('|')
      && /\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?/.test(separator.trim());

    if (!looksLikeTable) {
      output.push(header);
      i += 1;
      continue;
    }

    const blockStart = i;
    let blockEnd = i + 2;
    while (blockEnd < lines.length && lines[blockEnd].trim().startsWith('|')) {
      blockEnd += 1;
    }

    const headerCells = parseRow(lines[blockStart]);
    const keepMask = headerCells.map((cell) => !CITATION_COLUMN_HEADER_PATTERN.test(cell));
    const hasAnyRemoved = keepMask.some((keep) => !keep);

    if (!hasAnyRemoved) {
      output.push(...lines.slice(blockStart, blockEnd));
      i = blockEnd;
      continue;
    }

    const rebuildRow = (row: string): string | null => {
      const cells = parseRow(row);
      const kept = cells.filter((_cell, idx) => keepMask[idx]);
      if (kept.length === 0) return null;
      return `| ${kept.join(' | ')} |`;
    };

    const rebuiltHeader = rebuildRow(lines[blockStart]);
    const rebuiltSeparator = rebuildRow(lines[blockStart + 1])?.replace(/[^|]/g, '-') ?? null;
    if (rebuiltHeader && rebuiltSeparator) {
      output.push(rebuiltHeader);
      output.push(rebuiltSeparator);
      for (let rowIndex = blockStart + 2; rowIndex < blockEnd; rowIndex += 1) {
        const rebuilt = rebuildRow(lines[rowIndex]);
        if (rebuilt) output.push(rebuilt);
      }
    }

    i = blockEnd;
  }

  return output.join('\n');
};

const rewriteCitationArtifacts = (text: string): string => {
  let rewritten = removeCitationColumnsFromMarkdownTables(text);
  rewritten = stripRenderedCitationSections(rewritten);
  rewritten = rewritten
    .replace(/\s*(?:\[(\d+)\]|【\s*\d+\s*】|［\s*\d+\s*］|\((\d+)\))(?=[\s.,;:!?)]|$)/g, '')
    .replace(new RegExp(`[${SUPERSCRIPT_DIGITS}]`, 'g'), '')
    .replace(/\b(?:source|sources|reference|references|ref|refs)\s*#?\s*\d+\b/gi, '')
    .replace(/(?:^|\n)\s*(?:\[(?:\d+)\]\s*)+\s*(?=\n|$)/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Final safety scrub for OFF mode guarantees.
  rewritten = rewritten
    .replace(/\[(\d+)\]/g, '')
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:Sources|References)\s*:?\s*(?:\n|$)/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return rewritten;
};

const processCitationModeOn = async (input: CitationProcessInput): Promise<CitationProcessOutput> => {
  const processOnce = (raw: string) => {
    const stripped = stripRenderedCitationSections(raw);
    const normalized = normalizeCitationVariants(stripped);
    const mapped = mapCitationIndicesByAppearance(normalized);
    const validation = validateCitationIndices(mapped.mappedText, mapped.originalByMappedIndex, input.sources.length);
    const hasAnyCitation = collectCitationOccurrences(mapped.mappedText).length > 0;
    return { stripped, normalized, mapped, validation, hasAnyCitation };
  };

  let currentText = input.outputText;
  let pass = processOnce(currentText);
  let retryUsed = false;

  if ((!pass.validation.isValid || !pass.hasAnyCitation) && input.retryCanonicalize) {
    retryUsed = true;
    currentText = await input.retryCanonicalize([
      input.outputText,
      '',
      'Reformat citations ONLY as [n] and ensure every [n] matches an available source index from tool outputs.',
      'Do not fabricate citations.',
    ].join('\n'));
    pass = processOnce(currentText);
  }

  const withUnsupported = appendLackCitationForUnsupportedSpans(pass.mapped.mappedText, pass.validation.invalidMappedIndices);
  const withMissingCitationMarker = pass.hasAnyCitation ? withUnsupported : `${withUnsupported}[lack citation]`;
  const referencedOriginalIndices = new Set<number>();
  for (const mappedIndex of Array.from(pass.validation.referencedMappedIndices.values())) {
    const original = pass.mapped.originalByMappedIndex.get(mappedIndex);
    if (typeof original === 'number' && original >= 1 && original <= input.sources.length) {
      referencedOriginalIndices.add(original);
    }
  }

  const outputText = `${withMissingCitationMarker}${buildSourceAppendix(input.sources, referencedOriginalIndices)}`;

  return {
    outputText,
    normalizedText: withMissingCitationMarker,
    citationIndices: Array.from(referencedOriginalIndices).sort((a, b) => a - b),
    retryUsed,
  };
};

const processCitationModeOff = (input: CitationProcessInput): CitationProcessOutput => {
  const lightweight = lightweightCleanupOff(input.outputText);
  const rewritten = shouldRewriteCitationArtifacts(input.outputText, lightweight)
    ? rewriteCitationArtifacts(lightweight)
    : lightweight;

  return {
    outputText: rewritten,
    normalizedText: rewritten,
    citationIndices: [],
    retryUsed: false,
  };
};

export const processResponseCitations = async (input: CitationProcessInput): Promise<CitationProcessOutput> => {
  if (!input.sourceCitationEnabled) {
    return processCitationModeOff(input);
  }
  return processCitationModeOn(input);
};

import { cloneElement, isValidElement } from 'react';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';

type Props = {
  content: string;
};

type ParsedTable = {
  headers: string[];
  rows: string[][];
};

type TaskListPrefix = {
  checked: boolean;
  consumed: number;
};

const BRACED_TEXT_SPLIT_REGEX = /(\{[^{}\n]+\})/g;
const BRACED_TEXT_TEST_REGEX = /\{[^{}\n]+\}/;

function highlightBracedText(text: string): ReactNode {
  if (!BRACED_TEXT_TEST_REGEX.test(text)) return text;

  return text.split(BRACED_TEXT_SPLIT_REGEX).map((part, index) =>
    BRACED_TEXT_TEST_REGEX.test(part) ? (
      <span key={`braced-text-${index}`} style={{ color: '#0000FF' }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function highlightBracedTokens(node: ReactNode): ReactNode {
  if (typeof node === 'string') return highlightBracedText(node);
  if (Array.isArray(node)) return node.map((child) => highlightBracedTokens(child));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;

  return cloneElement(node, {
    ...node.props,
    children: highlightBracedTokens(node.props.children),
  });
}

function flattenText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(flattenText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return flattenText((children as { props?: { children?: ReactNode } }).props?.children ?? '');
  }
  return '';
}

function splitTableRow(row: string): string[] {
  const normalized = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split('|').map((cell) => cell.trim());
}

function parseTable(text: string): ParsedTable | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!lines[0].includes('|')) return null;

  const separator = lines[1].replace(/^\|/, '').replace(/\|$/, '').trim();
  const isSeparator = separator.length > 0 && separator.split('|').every((segment) => /^:?-{3,}:?$/.test(segment.trim()));
  if (!isSeparator) return null;

  const headers = splitTableRow(lines[0]);
  const rows = lines.slice(2).filter((line) => line.includes('|')).map(splitTableRow);
  return { headers, rows };
}

function parseTaskPrefix(text: string): TaskListPrefix | null {
  const match = text.match(/^\[(\s*|x\s*|X\s*)\]\s*/);
  if (!match) return null;
  const marker = match[1].trim().toLowerCase();
  return { checked: marker === 'x', consumed: match[0].length };
}

function isThematicBreak(line: string): boolean {
  const trimmed = line.trim();
  return /^([-*_])(?:\s*\1){2,}$/.test(trimmed);
}

function neutralizeShortSetextUnderlines(markdown: string): string {
  const lines = markdown.split('\n');

  for (let index = 1; index < lines.length; index += 1) {
    const current = lines[index];
    if (!/^\s*-{1,2}\s*$/.test(current)) continue;

    const previous = lines[index - 1]?.trim();
    if (!previous) continue;

    lines[index] = current.replace('-', '\\-');
  }

  return lines.join('\n');
}

function neutralizeStandaloneShortHyphenLines(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (/^\s*-{1,2}\s*$/.test(line) ? line.replace(/-/g, '\\-') : line))
    .join('\n');
}

const markdownComponents: Components = {
  hr() {
    return <hr />;
  },
  p({ children }) {
    const text = flattenText(children);
    if (text.trim() === '') return <p>{'\u00a0'}</p>;

    const table = parseTable(text);
    if (!table) return <p>{highlightBracedTokens(children)}</p>;

    return (
      <table>
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th key={`h-${index}`}>{highlightBracedText(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={`r-${rowIndex}`}>
              {table.headers.map((_, colIndex) => (
                <td key={`r-${rowIndex}-c-${colIndex}`}>{highlightBracedText(row[colIndex] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
  li({ children }) {
    const normalizedChildren = Array.isArray(children) ? [...children] : [children];
    const first = normalizedChildren[0];
    if (typeof first !== 'string') return <li>{highlightBracedTokens(children)}</li>;

    const task = parseTaskPrefix(first);
    if (!task) return <li>{highlightBracedTokens(children)}</li>;

    const firstRest = first.slice(task.consumed);
    const remainingChildren: ReactNode[] = [firstRest, ...normalizedChildren.slice(1)];
    while (remainingChildren.length > 0 && remainingChildren[0] === '') {
      remainingChildren.shift();
    }

    return (
      <li className="-ml-5 list-none">
        <label className="inline-flex items-start gap-2">
          <input type="checkbox" checked={task.checked} readOnly disabled className="mt-1" />
          <span>{highlightBracedTokens(remainingChildren)}</span>
        </label>
      </li>
    );
  },
  h1({ children }) {
    return <h1>{highlightBracedTokens(children)}</h1>;
  },
  h2({ children }) {
    return <h2>{highlightBracedTokens(children)}</h2>;
  },
  h3({ children }) {
    return <h3>{highlightBracedTokens(children)}</h3>;
  },
  h4({ children }) {
    return <h4>{highlightBracedTokens(children)}</h4>;
  },
  h5({ children }) {
    return <h5>{highlightBracedTokens(children)}</h5>;
  },
  h6({ children }) {
    return <h6>{highlightBracedTokens(children)}</h6>;
  },
};

export function MarkdownPreview({ content }: Props) {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const lines = normalizedContent.split('\n');
  const chunks: Array<{ type: 'markdown'; content: string } | { type: 'blank' } | { type: 'hr' }> = [];
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    chunks.push({ type: 'markdown', content: buffer.join('\n') });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushBuffer();
      chunks.push({ type: 'blank' });
      continue;
    }

    if (isThematicBreak(line)) {
      flushBuffer();
      chunks.push({ type: 'hr' });
      continue;
    }

    buffer.push(line);
  }

  flushBuffer();

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.type === 'blank' ? (
          <p key={`blank-${index}`}>{'\u00a0'}</p>
        ) : chunk.type === 'hr' ? (
          <hr key={`hr-${index}`} />
        ) : (
          <ReactMarkdown key={`md-${index}`} components={markdownComponents}>
            {neutralizeStandaloneShortHyphenLines(neutralizeShortSetextUnderlines(chunk.content))}
          </ReactMarkdown>
        ),
      )}
    </>
  );
}

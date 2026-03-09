import type { ReactNode } from 'react';
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

export function MarkdownPreview({ content }: Props) {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const contentWithVisibleEmptyRows = normalizedContent
    .split('\n')
    .map((line) => (line.trim() === '' ? '\u00a0' : line))
    .join('\n');

  return (
    <ReactMarkdown
      components={{
        p({ children }) {
          const text = flattenText(children);
          const table = parseTable(text);
          if (!table) return <p>{children}</p>;

          return (
            <table>
              <thead>
                <tr>
                  {table.headers.map((header, index) => (
                    <th key={`h-${index}`}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`}>
                    {table.headers.map((_, colIndex) => (
                      <td key={`r-${rowIndex}-c-${colIndex}`}>{row[colIndex] ?? ''}</td>
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
          if (typeof first !== 'string') return <li>{children}</li>;

          const task = parseTaskPrefix(first);
          if (!task) return <li>{children}</li>;

          const firstRest = first.slice(task.consumed);
          const remainingChildren: ReactNode[] = [firstRest, ...normalizedChildren.slice(1)];
          while (remainingChildren.length > 0 && remainingChildren[0] === '') {
            remainingChildren.shift();
          }

          return (
            <li className="-ml-5 list-none">
              <label className="inline-flex items-start gap-2">
                <input type="checkbox" checked={task.checked} readOnly disabled className="mt-1" />
                <span>{remainingChildren}</span>
              </label>
            </li>
          );
        },
      }}
    >
      {contentWithVisibleEmptyRows}
    </ReactMarkdown>
  );
}

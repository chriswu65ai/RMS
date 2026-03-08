import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

type Props = {
  content: string;
};

type ParsedTable = {
  headers: string[];
  rows: string[][];
};

type TaskListState = {
  checked: boolean;
  label: string;
};

function parseTaskListItem(text: string): TaskListState | null {
  const match = text.match(/^\[( |x|X)\]\s+(.*)$/s);
  if (!match) return null;
  return {
    checked: match[1].toLowerCase() === 'x',
    label: match[2],
  };
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

export function MarkdownPreview({ content }: Props) {
  const normalizedContent = content
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, (newlines) => `\n\n${'  \n'.repeat(Math.max(0, newlines.length - 2))}`)
    .replace(/(?<!\n)\n(?!\n)/g, '  \n');

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
          const text = flattenText(children).trim();
          const task = parseTaskListItem(text);
          if (!task) return <li>{children}</li>;

          return (
            <li className="-ml-5 list-none">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={task.checked} readOnly disabled />
                <span>{task.label}</span>
              </label>
            </li>
          );
        },
      }}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
}

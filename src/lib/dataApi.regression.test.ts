import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('dataApi keeps empty note_type instead of coercing to Research', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/lib/dataApi.ts'), 'utf8');

  assert.match(source, /note_type:\s*values\.note_type\.trim\(\)/);
  assert.match(source, /note_type:\s*row\.note_type\.trim\(\)/);
  assert.doesNotMatch(source, /note_type:\s*values\.note_type\.trim\(\)\s*\|\|\s*'Research'/);
  assert.doesNotMatch(source, /note_type:\s*row\.note_type\.trim\(\)\s*\|\|\s*'Research'/);
});

test('attachment upload uses multipart FormData and avoids base64 buffer inflation', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/lib/dataApi.ts'), 'utf8');

  assert.match(source, /new FormData\(\)/);
  assert.match(source, /formData\.append\('file', params\.file, params\.file\.name\)/);
  assert.doesNotMatch(source, /content_base64/);
  assert.doesNotMatch(source, /\bbtoa\(/);
});

test('file list does not fetch attachment details during render-time list updates', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/files/FileList.tsx'), 'utf8');

  assert.doesNotMatch(source, /listAttachments/);
  assert.doesNotMatch(source, /attachmentCounts/);
});

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

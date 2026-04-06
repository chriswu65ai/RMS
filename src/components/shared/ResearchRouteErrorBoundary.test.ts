import test from 'node:test';
import assert from 'node:assert/strict';
import { clearedResearchRouteBoundaryState, shouldResetResearchRouteBoundary } from './researchRouteErrorBoundaryState.js';

test('research route error boundary supports recovery without browser refresh', () => {
  assert.equal(shouldResetResearchRouteBoundary('research:/a', 'research:/b'), true);
  assert.equal(shouldResetResearchRouteBoundary('research:/a', 'research:/a'), false);
  assert.deepEqual(clearedResearchRouteBoundaryState(), { hasError: false });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAttachmentTelemetrySnapshot, resetAttachmentTelemetry, trackAttachmentEndpoint } from './attachmentTelemetry.js';
import { createRequestLimiter } from './requestLimiter.js';

test('request limiter caps concurrent work to configured max', async () => {
  const limiter = createRequestLimiter(3);
  let active = 0;
  let peakActive = 0;

  await Promise.all(
    Array.from({ length: 8 }, (_, index) => limiter.schedule(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5 + index));
      active -= 1;
      return index;
    })),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(peakActive, 3);
  assert.equal(limiter.getActiveCount(), 0);
  assert.equal(limiter.getPendingCount(), 0);
});

test('attachment telemetry tracks call count and latency for list navigation scenarios', () => {
  resetAttachmentTelemetry();
  trackAttachmentEndpoint('counts', 18);
  trackAttachmentEndpoint('counts', 12);
  trackAttachmentEndpoint('list', 9);

  const telemetry = getAttachmentTelemetrySnapshot();
  const countsMetric = telemetry.find((entry) => entry.endpoint === 'counts');
  assert.ok(countsMetric);
  assert.equal(countsMetric?.callCount, 2);
  assert.equal(countsMetric?.totalLatencyMs, 30);
  assert.equal(countsMetric?.averageLatencyMs, 15);
  assert.equal(countsMetric?.maxLatencyMs, 18);
  resetAttachmentTelemetry();
});

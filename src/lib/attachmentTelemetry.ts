type AttachmentEndpointMetric = {
  callCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
};

const metrics = new Map<string, AttachmentEndpointMetric>();

export function trackAttachmentEndpoint(endpoint: string, latencyMs: number) {
  const safeLatency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
  const existing = metrics.get(endpoint);
  if (!existing) {
    metrics.set(endpoint, {
      callCount: 1,
      totalLatencyMs: safeLatency,
      maxLatencyMs: safeLatency,
    });
    return;
  }
  existing.callCount += 1;
  existing.totalLatencyMs += safeLatency;
  existing.maxLatencyMs = Math.max(existing.maxLatencyMs, safeLatency);
}

export function getAttachmentTelemetrySnapshot() {
  return Array.from(metrics.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([endpoint, metric]) => ({
      endpoint,
      callCount: metric.callCount,
      totalLatencyMs: metric.totalLatencyMs,
      maxLatencyMs: metric.maxLatencyMs,
      averageLatencyMs: metric.callCount > 0 ? Math.round(metric.totalLatencyMs / metric.callCount) : 0,
    }));
}

export function resetAttachmentTelemetry() {
  metrics.clear();
}

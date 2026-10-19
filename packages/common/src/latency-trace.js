import crypto from 'node:crypto';

/**
 * Lightweight, allocation-cheap latency tracing for the payment-detection
 * critical path (observer ingest → pipeline → DB → checkout update).
 *
 * A trace is created once per inbound request (correlation id taken from the
 * caller's `X-Correlation-Id` header when present, otherwise generated) and
 * shared with the verification pipeline so parsing / matching / persistence can
 * be timed without changing any decision logic.
 *
 * Segments are reported as the delta between consecutive marks, so a trace line
 * reads left-to-right: auth → body_parse → sms_parse → pipeline → db_write.
 */
export class LatencyTrace {
  /** @param {string} [correlationId] */
  constructor(correlationId) {
    this.correlationId = correlationId || crypto.randomUUID();
    this.startedAt = Date.now();
    this.t0 = process.hrtime.bigint();
    /** @type {Record<string, number>} */
    this.marks = {};
  }

  /** Records an absolute mark (ms since trace start) and returns it. */
  mark(name) {
    const ms = Number(process.hrtime.bigint() - this.t0) / 1e6;
    this.marks[name] = ms;
    return ms;
  }

  /** Total elapsed ms since the trace was created. */
  get totalMs() {
    return Number(process.hrtime.bigint() - this.t0) / 1e6;
  }

  /**
   * @param {Record<string, number>} [extra] Additional scalar timings/counters.
   * @returns {{ correlationId: string, totalMs: number, startedAt: string, segments: Record<string, number> } & Record<string, any>}
   */
  snapshot(extra = {}) {
    const names = Object.keys(this.marks);
    const segments = {};
    for (let i = 0; i < names.length; i++) {
      const from = i === 0 ? 0 : this.marks[names[i - 1]];
      segments[names[i]] = round(this.marks[names[i]] - from);
    }
    return {
      correlationId: this.correlationId,
      totalMs: round(this.totalMs),
      startedAt: new Date(this.startedAt).toISOString(),
      segments,
      ...extra
    };
  }

  /** Compact single-line header form: `corr=<id>;total=<ms>;auth=<ms>;...`. */
  header(extra = {}) {
    const parts = [`corr=${this.correlationId}`, `total=${round(this.totalMs)}`];
    for (const [name, ms] of Object.entries(this.marks)) parts.push(`${name}=${round(ms)}`);
    for (const [name, value] of Object.entries(extra)) parts.push(`${name}=${value}`);
    return parts.join(';');
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

/** Correlation id supplied by the caller (trimmed) or a fresh UUID. */
export function resolveCorrelationId(req) {
  const supplied = req?.headers?.['x-correlation-id'];
  const value = typeof supplied === 'string' ? supplied.trim() : '';
  return value && value.length <= 128 ? value : crypto.randomUUID();
}

/** Creates and attaches a trace to the request (`req.trace`). */
export function startRequestTrace(req) {
  const trace = new LatencyTrace(resolveCorrelationId(req));
  req.trace = trace;
  return trace;
}

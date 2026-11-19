'use strict';

/**
 * Tiny dependency-free Prometheus metrics (counters + histograms + gauges).
 * Exposed at GET /metrics. Labels are only ever fixed enums (decision, risk),
 * never user input, so cardinality stays bounded.
 */

const DEFAULT_BUCKETS = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5, 30];

const labelKey = (labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/[\\"\n]/g, '_')}"`)
    .join(',');

class Metrics {
  constructor() {
    this.counters = new Map(); // name -> Map(labelKey -> value)
    this.histograms = new Map(); // name -> {buckets, counts[], sum, count}
    this.help = new Map();
    this.startedAt = Date.now();
  }

  describe(name, text) {
    this.help.set(name, text);
  }

  inc(name, labels = {}, by = 1) {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const series = this.counters.get(name);
    const key = labelKey(labels);
    series.set(key, (series.get(key) || 0) + by);
  }

  observe(name, value, buckets = DEFAULT_BUCKETS) {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, { buckets, counts: buckets.map(() => 0), sum: 0, count: 0 });
    }
    const h = this.histograms.get(name);
    h.sum += value;
    h.count += 1;
    h.buckets.forEach((b, i) => {
      if (value <= b) h.counts[i] += 1;
    });
  }

  /** @param {Record<string, number>} gauges  point-in-time values supplied by the caller */
  render(gauges = {}) {
    const out = [];
    const head = (name, type) => {
      if (this.help.has(name)) out.push(`# HELP ${name} ${this.help.get(name)}`);
      out.push(`# TYPE ${name} ${type}`);
    };

    for (const [name, series] of this.counters) {
      head(name, 'counter');
      for (const [key, value] of series) out.push(`${name}${key ? `{${key}}` : ''} ${value}`);
    }

    for (const [name, h] of this.histograms) {
      head(name, 'histogram');
      h.buckets.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${h.counts[i]}`));
      out.push(`${name}_bucket{le="+Inf"} ${h.count}`);
      out.push(`${name}_sum ${h.sum}`);
      out.push(`${name}_count ${h.count}`);
    }

    for (const [name, value] of Object.entries({
      firewall_uptime_seconds: (Date.now() - this.startedAt) / 1000,
      ...gauges,
    })) {
      head(name, 'gauge');
      out.push(`${name} ${value}`);
    }

    return out.join('\n') + '\n';
  }
}

module.exports = { Metrics };

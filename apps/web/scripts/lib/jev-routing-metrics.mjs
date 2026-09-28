const sources = ['architecture', 'records', 'knowledge', 'brain'];
const same = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');
export function routingMetrics(rows) {
  const accepted = rows.filter(row => row.result.status === 'ok');
  const labeled = accepted.filter(row => Array.isArray(row.expectedSources));
  const times = rows.map(row => row.result.elapsedMs).sort((a, b) => a - b);
  const perSource = Object.fromEntries(sources.map(source => {
    const falsePositive = labeled.filter(r => r.result.sources.includes(source) && !r.expectedSources.includes(source)).length;
    const falseNegative = labeled.filter(r => !r.result.sources.includes(source) && r.expectedSources.includes(source)).length;
    // Every observed probability is included, even if the joint decision abstained.
    const observations = rows.filter(r => Array.isArray(r.expectedSources) && Number.isFinite(r.result.sourceProbabilities?.[source]));
    const bins = Array.from({ length: 5 }, (_, index) => {
      const members = observations.filter(r => Math.min(4, Math.floor(r.result.sourceProbabilities[source] * 5)) === index);
      return { lower: index / 5, upper: (index + 1) / 5, count: members.length,
        meanProbability: members.length ? members.reduce((n, r) => n + r.result.sourceProbabilities[source], 0) / members.length : null,
        observedPositiveRate: members.length ? members.filter(r => r.expectedSources.includes(source)).length / members.length : null };
    });
    return [source, { falsePositive, falseNegative, bins }];
  }));
  return { total: rows.length, accepted: accepted.length, degraded: rows.filter(r => r.result.status === 'degraded').length,
    acceptanceRate: rows.length ? accepted.length / rows.length : null,
    acceptedLabeled: labeled.length, acceptedExactAccuracy: labeled.length ? labeled.filter(r => same(r.result.sources, r.expectedSources)).length / labeled.length : null,
    medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
    perSource, note: 'Source errors count accepted labeled cases only. Abstentions are reported separately; bins are observations, not proof of calibration.' };
}

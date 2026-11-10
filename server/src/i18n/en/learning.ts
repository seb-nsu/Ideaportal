export const learning = {
  // Metrics before and after (R4-04)
  'learning.metric.notFound': 'The metric was not found.',
  'learning.metric.defineOnlyGate2': 'Metrics are fixed at Gate 2: while the idea is in elaboration, by the mentor, the submitters, the triage team or the committee.',
  'learning.metric.connectorNeeded': 'Measuring through a connector needs the connector and the query.',
  'learning.metric.period': 'The end of the period is before its start.',
  'learning.metric.periodLong': 'The comparison period can be at most one year long.',
  'learning.metric.recordForbidden': 'Values can be recorded by the triage team, the mentor, the person responsible for the implementation and API tokens with the implementer, triage or admin role.',
  'learning.metric.fromConnector': 'The values of this metric come from the connector and are measured automatically.',
  'learning.metric.notConnector': 'This metric is not measured through a connector.',
  'learning.event.defined': 'Metric for the before/after comparison fixed: {name} ({unit}).',
  // Report draft for Gate 3 (R4-04)
  'learning.report.heading': 'Draft impact report for #{number} "{title}"',
  'learning.report.noMetric': 'No metric was fixed at Gate 2.',
  'learning.report.metric': 'Metric: {name} ({unit})',
  'learning.report.baseline': '- Before: {value} {unit} (period {from} to {to})',
  'learning.report.baselineMissing': '- Before: no value measured yet',
  'learning.report.after': '- After: {value} {unit} (period {from} to {to})',
  'learning.report.afterMissing': '- After: no value measured yet',
  'learning.report.change.better': '- Change: {change} {unit} ({percent} %), in the desired direction',
  'learning.report.change.worse': '- Change: {change} {unit} ({percent} %), against the desired direction',
  'learning.report.change.same': '- Change: none',
  'learning.report.benefit': 'Benefit in euro: planned {plan}, actual {actual}.',
  'learning.report.band': 'Earlier forecasts of the same idea type: actual benefit mostly between {low} % and {high} % of the forecast ({n} closed ideas).',
  'learning.report.bandMissing': 'Hit band of earlier forecasts: not enough closed ideas yet.',
  'learning.report.footer': 'Draft from the measured values. The reviewing person makes the assessment and the recommendation.',
  // Effort estimate (R4-06)
  'learning.effort.forbidden': 'The effort estimate is shown to the mentor, the triage team, the committee and heads of department.',
} as const;

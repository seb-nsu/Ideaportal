// English texts for the namespace "process" (R3-03).
export const processTexts: Record<string, string> = {
  'process.lane.fast_lane': 'Fast lane when implementation costs at most {days} person-days and {euro} € and a department can take it on itself.',
  'process.lane.elaborateCommittee': 'Elaborate when the idea is larger or affects several departments: about {weeks} weeks of elaboration, then the committee decides at Gate 2 (up to {days} person-days and {euro} € the area lead may decide alone).',
  'process.lane.elaborateLead': 'Elaborate when the idea is larger or affects several departments: about {weeks} weeks of elaboration, then the area lead decides at Gate 2 (up to {days} person-days and {euro} €; above that the management).',
  'process.lane.forward': 'Forward when the request is an incident, a complaint, a safety topic or a report and has its own channel.',
  'process.lane.reject': 'Reject with reasons when the idea does not fit the goals, already exists or the effort clearly exceeds the benefit.',
  'process.rule.load': 'With about {ideas} ideas a year and {reviewers} people in triage, that is about {load} ideas per person and week; hence a Gate 1 deadline of {days} working days.',
  'process.rule.innovation': 'Innovation teams elaborate ideas more thoroughly: {days} working days of elaboration, strategy and benefit weighted equally.',
  'process.rule.product': 'Product teams decide faster and close to the customer: {days} working days of elaboration, customer value weighted highest.',
  'process.rule.fastLane': 'A fast lane up to {euro} € suits an organisation with about {employees} employees; small ideas move on without a committee.',
  'process.rule.cost': 'The description stresses cost and efficiency: economic value is weighted slightly higher.',
  'process.rule.risk': 'The description stresses risk and rules: the risk criterion is weighted slightly higher.',
  'process.weight.innovation': 'Weight of the template for innovation teams.',
  'process.weight.product': 'Weight of the template for product teams.',
};

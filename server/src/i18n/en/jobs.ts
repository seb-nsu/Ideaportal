// English texts for the namespace "jobs" (R3-22).
export const jobs: Record<string, string> = {
  'jobs.overdue.subject': 'Deadline exceeded: #{number} “{title}”',
  'jobs.overdue.body': 'The deadline for #{number} “{title}” has been exceeded by {days} working day(s) (due {date}). Please see to a decision.',
  'jobs.event.escalated': 'Deadline exceeded (due {date}), escalated to management.',
  'jobs.reminder.subject': 'Reminder: deadline for #{number} “{title}”',
  'jobs.reminder.body': 'The deadline for #{number} “{title}” ends in {days} working day(s) on {date}.',
  'jobs.late.subject': 'Implementation behind schedule: #{number} “{title}”',
  'jobs.late.body': 'The target date {date} for #{number} “{title}” has passed. Please update progress and target date or complete the implementation with the actual benefit.',
  'jobs.guarantee.subject': 'Response guarantee missed: {quota} % instead of {threshold} %',
  'jobs.guarantee.body': 'In the last 90 days, {met} of {due} ideas got a first response within {workdays} working days ({quota} %). The threshold is {threshold} %. Please check the open ideas on the board. This notice comes again only after the quota has reached the threshold and drops below it once more.',
};

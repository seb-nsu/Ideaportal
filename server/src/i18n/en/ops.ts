// English texts for the namespace "ops" (R3-22).
export const ops: Record<string, string> = {
  'ops.jobsStale': 'Background rules (deadlines, reminders, mails) have not run for {minutes} minutes.',
  'ops.jobsFailed': 'The last run of the background rules failed.',
  'ops.aiQueue': 'AI queue: {count} jobs waiting (threshold {max}).',
  'ops.aiOldest': 'The oldest AI job has been waiting for {minutes} minutes.',
  'ops.outboxBacklog': 'Mail backlog: {count} mails waiting (threshold {max}).',
  'ops.outboxOldest': 'The oldest mail has been waiting to be sent for {minutes} minutes.',
  'ops.subjectRaised': '[Ideenportal] Alert',
  'ops.subjectCleared': '[Ideenportal] All clear',
  'ops.raisedText': 'Ideenportal: {alerts} Details: {url}',
  'ops.clearedText': 'Ideenportal: back to normal ({keys}).',
};

// English texts for the namespace "security".
export const security: Record<string, string> = {
  'security.password.tooShort': 'The password needs at least {min} characters.',
  'security.password.tooLong': 'The password may have at most {max} characters.',
  'security.password.common': 'This password is too common. Please choose another one.',
  'security.password.personal': 'The password must not contain your e-mail address or the name of the workspace.',
  'security.password.breached': 'This password is known from data breaches. Please choose another one.',
  'security.idleMin': 'The idle sign-out is off (0) or takes at least 5 minutes.',
  'security.siem.notFound': 'No SIEM target is set up.',
  'security.siem.failingSubject': 'Forwarding the audit log to the SIEM fails',
  'security.siem.failingBody':
    'Forwarding to {host} failed {n} times in a row. Nothing is lost: the portal keeps trying. Please check the target under Administration › Security.',
  'security.auditCsv.seq': 'Chain no.',
  'security.auditCsv.email': 'E-mail',
  'security.auditCsv.ipHash': 'Address (hash)',
  'security.auditCsv.userAgent': 'Browser',
  'security.auditCsv.requestId': 'Request id',
  'security.auditCsv.rowHash': 'Checksum',
};

// SaaS operations (AP-17): settings version (R3-41), operator console and support access (R3-07), status page (R3-10).
export const saas: Record<string, string> = {
  'saas.settingsConflict': 'Someone else has changed the settings in the meantime. The current version is loaded; please enter your change again.',
  'saas.settingsVersionInvalid': 'The version (If-Match) is invalid.',
  'saas.operatorDisabled': 'The operator console is not set up.',
  'saas.operatorUnauthenticated': 'Please sign in to the operator console.',
  'saas.operatorLoginFailed': 'Access key or code is wrong.',
  'saas.slugTaken': 'This short name is already taken.',
  'saas.tenantNotFound': 'Workspace not found.',
  'saas.supportNoGrant': 'The workspace has not granted support access.',
  'saas.incidentNotFound': 'Notice not found.',
  'saas.invite.subject': 'Your Ideenportal workspace is ready',
  'saas.invite.intro': 'The workspace "{workspace}" has been set up for you. You are its admin. Use this link to set your password (valid for 24 hours):',
};

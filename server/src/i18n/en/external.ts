// English texts for the namespace "external" (R3-19, R3-20, R3-21).
export const external: Record<string, string> = {
  'external.forbidden': 'This function is not available to external accounts.',
  'external.disabled': 'External participation is not switched on in this workspace.',
  'external.linkInvalid': 'The link is invalid, or the challenge is no longer open to external participants.',
  'external.noAccess': 'You are not taking part in this challenge.',
  'external.challengeNotExternal': 'The challenge is not open to external participants.',
  'external.challengeClosed': 'The challenge is not taking ideas at the moment.',
  'external.consentRequired': 'Please first accept the terms of use and the consent text of the challenge.',
  'external.consentChanged': 'The text has changed in the meantime. Please read the new version and accept it again.',
  'external.consentUnknown': 'This consent text is no longer valid.',
  'external.accountExists': 'An account with this e-mail address already exists. Please sign in and open the link again afterwards.',
  'external.internalAccount': 'There is an internal account with this e-mail address. Internal people do not need an invitation.',
  'external.spam': 'The post was recognised as spam and was not saved.',
  'external.tooManyLinks': 'The post contains too many links. At most {max} are allowed.',
  'external.invite.subject': 'Invitation to the challenge “{challenge}”',
  'external.invite.intro': '{name} invites you to submit ideas to the challenge “{challenge}”. Set your password here:',
  'external.access.subject': 'New challenge for you: “{challenge}”',
  'external.access.body': 'You can now also take part in the challenge “{challenge}”. Sign in: {url}',
  'external.defaultTerms':
    'Draft – have it reviewed by a lawyer and adapt it before use.\n\n' +
    'Terms of use for external participants\n\n' +
    '1. The idea portal is used to submit ideas to challenges of the operator. It is not a channel for reporting legal violations.\n' +
    '2. You only submit content that you developed yourself or for which you hold the necessary rights. You do not submit third-party content, trade secrets of other companies or personal data of third parties.\n' +
    '3. The consent text of each challenge sets out which rights the operator receives to your ideas and how confidentially they are treated.\n' +
    '4. You see your own ideas and the released ideas of other participants in the same challenge. You do not see internal ideas, comments or reports of the operator.\n' +
    '5. Posts may be reviewed before publication. Posts with advertising, insults or unlawful content are not published or are removed.\n' +
    '6. There is no claim to implementation, a particular form of response or remuneration unless the consent text of the challenge says otherwise.\n' +
    '7. You can have your account deleted at any time. The privacy notice of the operator applies in addition.',
  'external.defaultConsent':
    'Draft – have it reviewed by a lawyer and adapt it before use.\n\n' +
    'Consent to usage rights and confidentiality\n\n' +
    '1. By submitting, you grant the operator the non-exclusive right, unlimited in time and place, to review, develop and implement your idea.\n' +
    '2. Your idea is treated confidentially: only the operator’s team and – after release – other participants of this challenge can see it, unless you mark it as confidential.\n' +
    '3. Remuneration is paid only if it is expressly promised for this challenge.\n' +
    '4. Before you submit an idea that could be an invention, please talk to us. Such ideas are checked for intellectual property rights before any publication (invention review).',
  'external.reportExists': 'You have already reported this post.',
  'external.reportOwn': 'You cannot report your own posts.',
  'external.reportClosed': 'The report has already been handled.',
  'external.notPending': 'This idea is not waiting for release.',
  'external.feature.off': 'Feature requests are not switched on in this workspace.',
  'external.feature.notFound': 'Feature request not found.',
  'external.feature.publicOff': 'The status page is not public.',
  'external.feature.statusSubject': 'Feature request #{number}: ',
  'external.feature.statusBody': 'The feature request “{title}” now has the status: ',
  'external.feature.statusNote': 'Note from the product team: {note}',
  'external.feature.status.new': 'new',
  'external.feature.status.planned': 'planned',
  'external.feature.status.in_progress': 'in progress',
  'external.feature.status.done': 'done',
  'external.feature.status.declined': 'declined',
};

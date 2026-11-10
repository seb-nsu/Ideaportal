// Company login with SAML 2.0 (R3-26).
export const saml = {
  'saml.entityRequired': 'Enter the entity ID (issuer) of the identity provider.',
  'saml.ssoUrlRequired': 'Enter the sign-in URL (SSO URL) of the identity provider. It must start with https://.',
  'saml.certRequired': 'Enter at least one signing certificate of the identity provider.',
  'saml.certInvalid': 'A certificate is invalid. Paste it as PEM or Base64.',
  'saml.certExpired': 'All certificates have expired. Download the current certificate from the identity provider.',
  'saml.metadataMissing': 'Enter a metadata URL or paste the metadata as XML.',
  'saml.metadataInvalid': 'The metadata could not be read ({reason}).',
} as const;

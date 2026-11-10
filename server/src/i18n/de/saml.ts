// Company login with SAML 2.0 (R3-26).
export const saml = {
  'saml.entityRequired': 'Gib die Entity-ID (Aussteller) des Identitätsanbieters an.',
  'saml.ssoUrlRequired': 'Gib die Anmelde-URL (SSO-URL) des Identitätsanbieters an. Sie muss mit https:// beginnen.',
  'saml.certRequired': 'Gib mindestens ein Signaturzertifikat des Identitätsanbieters an.',
  'saml.certInvalid': 'Ein Zertifikat ist ungültig. Füge es als PEM oder Base64 ein.',
  'saml.certExpired': 'Alle Zertifikate sind abgelaufen. Lade das aktuelle Zertifikat beim Identitätsanbieter herunter.',
  'saml.metadataMissing': 'Gib eine Metadaten-URL an oder füge die Metadaten als XML ein.',
  'saml.metadataInvalid': 'Die Metadaten konnten nicht gelesen werden ({reason}).',
} as const;

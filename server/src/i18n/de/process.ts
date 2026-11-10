// Rule-based process proposal of the builtin provider (R3-03).
export const processTexts = {
  'process.lane.fast_lane': 'Schnellspur, wenn die Umsetzung höchstens {days} Personentage und {euro} € kostet und ein Fachbereich sie selbst übernehmen kann.',
  'process.lane.elaborateCommittee': 'Ausarbeiten, wenn die Idee größer ist oder mehrere Bereiche betrifft: rund {weeks} Wochen Ausarbeitung, danach entscheidet das Gremium an Gate 2 (bis {days} Personentage und {euro} € darf die Bereichsleitung selbst entscheiden).',
  'process.lane.elaborateLead': 'Ausarbeiten, wenn die Idee größer ist oder mehrere Bereiche betrifft: rund {weeks} Wochen Ausarbeitung, danach entscheidet die Bereichsleitung an Gate 2 (bis {days} Personentage und {euro} €; darüber die Geschäftsführung).',
  'process.lane.forward': 'Weiterleiten, wenn das Anliegen eine Störung, Beschwerde, ein Arbeitsschutzthema oder ein Hinweis ist und einen eigenen Kanal hat.',
  'process.lane.reject': 'Ablehnen mit Begründung, wenn die Idee nicht zu den Zielen passt, schon umgesetzt ist oder der Aufwand den Nutzen deutlich übersteigt.',
  'process.rule.load': 'Bei rund {ideas} Ideen im Jahr und {reviewers} Personen in der Triage sind das etwa {load} Ideen pro Person und Woche; daher eine Gate-1-Frist von {days} Arbeitstagen.',
  'process.rule.innovation': 'Innovationsteams arbeiten Ideen gründlicher aus: {days} Arbeitstage Ausarbeitung, Strategie und Nutzen gleich stark gewichtet.',
  'process.rule.product': 'Produktteams entscheiden schneller und nah am Kunden: {days} Arbeitstage Ausarbeitung, Kundennutzen am stärksten gewichtet.',
  'process.rule.fastLane': 'Die Schnellspur bis {euro} € passt zu einer Organisation mit rund {employees} Mitarbeitenden; kleine Ideen kommen so ohne Gremium voran.',
  'process.rule.cost': 'Die Beschreibung betont Kosten und Effizienz: Der wirtschaftliche Nutzen ist etwas stärker gewichtet.',
  'process.rule.risk': 'Die Beschreibung betont Risiko und Regeln: Das Kriterium Risiko ist etwas stärker gewichtet.',
  'process.weight.innovation': 'Gewicht der Vorlage für Innovationsteams.',
  'process.weight.product': 'Gewicht der Vorlage für Produktteams.',
} as const;

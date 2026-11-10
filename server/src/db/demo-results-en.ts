import type { Source } from '../ai/content.js';
import type { StoredContent } from '../ai/pipeline.js';
import { assume, content as contentDe, estimate, fact } from './demo-results.js';

// English version of the pre-generated demo analyses (R2-40, R3-22); same content as the
// German set in demo-results.ts, for the English demo workspace.

const content = (agent: string, data: Record<string, unknown>, sections: Parameters<typeof contentDe>[2], sources: Source[] = []) =>
  contentDe(agent, data, sections, sources, 'en');

const WEB_SOURCES: Source[] = [
  {
    id: 1,
    title: 'Syncron – service parts management for manufacturers',
    url: 'https://www.syncron.com/',
    snippet: 'Provider of software for spare parts planning, pricing and spare part portals of manufacturers.',
    origin: 'web',
    retrievedAt: '2026-10-12',
  },
  {
    id: 2,
    title: 'Partium – spare part search for industry',
    url: 'https://www.partium.io/',
    snippet: 'Software to search and identify spare parts, also by photo or serial number.',
    origin: 'web',
    retrievedAt: '2026-10-12',
  },
  {
    id: 3,
    title: 'SAP Commerce Cloud',
    url: 'https://www.sap.com/products/crm/commerce-cloud.html',
    snippet: 'B2B commerce platform with connection to SAP ERP; prices on request.',
    origin: 'web',
    retrievedAt: '2026-10-12',
  },
];

export function portalResultsEn(): Record<string, StoredContent> {
  return {
    short_analysis: content(
      'short_analysis',
      {
        summary:
          'Customers should find and order spare parts themselves by serial number. This relieves the sales office at peak times and can bring additional revenue.',
        completeness: { complete: false, missing: ['Number of spare part calls per month', 'Share of parts with clean master data'] },
      },
      [
        {
          heading: 'What it is about',
          claims: [
            assume('Today spare part orders run almost entirely through the phone of the sales office.'),
            assume('A portal with search by serial number should take over the simple orders.'),
          ],
        },
        {
          heading: 'Competitors and substitutes',
          claims: [
            fact('There is specialised software for manufacturers’ spare part portals.', [1]),
            fact('Spare part search by serial number or photo is offered as a product of its own.', [2]),
            fact('Large B2B commerce platforms offer ERP connections; they only quote prices on request.', [3]),
          ],
        },
        { heading: 'Market and benefit', claims: [estimate('For simple reorders, experience shows that 20 to 40 % of calls can move to a portal.', 'low')] },
        {
          heading: 'Open questions',
          claims: [
            assume('How many calls are plain reorders, and how many need advice?'),
            assume('Are the serial numbers in the ERP system linked to the parts lists?'),
          ],
        },
      ],
      WEB_SOURCES,
    ),
    triage_suggestion: content(
      'triage_suggestion',
      {
        lane: 'elaborate',
        topic: 'Products and services',
        confidence: 'medium',
        reason: 'The idea affects customers, sales and IT and needs a decision on buying or building. An elaboration with a business case makes sense.',
        missing: ['Call numbers of the sales office'],
      },
      [],
    ),
    competition: content(
      'competition',
      {
        matrix: [
          {
            name: 'Syncron',
            kind: 'competitor',
            features: 'Spare parts planning, pricing, customer portal',
            price: 'on request',
            priceOnRequest: true,
            strengths: 'Focus on manufacturer service',
            weaknesses: 'Large scope, long roll-out',
            sources: [1],
          },
          {
            name: 'Partium',
            kind: 'substitute',
            features: 'Part search by serial number and photo',
            price: 'on request',
            priceOnRequest: true,
            strengths: 'Fast identification of parts',
            weaknesses: 'Ordering and ERP connection to be clarified separately',
            sources: [2],
          },
          {
            name: 'SAP Commerce Cloud',
            kind: 'substitute',
            features: 'B2B shop with ERP connection',
            price: 'on request',
            priceOnRequest: true,
            strengths: 'Fits an SAP ERP',
            weaknesses: 'Elaborate for a pure spare parts shop',
            sources: [3],
          },
        ],
      },
      [
        {
          heading: 'Overview',
          claims: [
            fact('There are specialised providers for spare part portals.', [1]),
            fact('Part identification is also offered as a stand-alone product.', [2]),
          ],
        },
        {
          heading: 'Gaps and opportunities',
          claims: [
            assume('A lean solution based on the existing ERP can start faster than a large platform.'),
            assume('All providers quote prices only on request; a comparison needs offers.'),
          ],
        },
      ],
      WEB_SOURCES,
    ),
    positioning: content(
      'positioning',
      {
        axisX: { label: 'Scope of functions', low: 'ordering only', high: 'service suite' },
        axisY: { label: 'Effort to introduce', low: 'low', high: 'high' },
        items: [
          { name: 'Our idea', x: 3, y: 3, isIdea: true, priceOnRequest: false },
          { name: 'Syncron', x: 8, y: 8, isIdea: false, priceOnRequest: true },
          { name: 'Partium', x: 4, y: 4, isIdea: false, priceOnRequest: true },
          { name: 'SAP Commerce Cloud', x: 7, y: 7, isIdea: false, priceOnRequest: true },
        ],
        recommendation: 'combine',
        reasoning:
          'Buy the part search and handle ordering through the existing ERP. That keeps the effort small and solves the hardest part (finding parts). The positions are assessments.',
        toClarify: [],
      },
      [{ heading: 'Note', claims: [assume('The positions are assessments and need to be checked against offers from the providers.')] }],
    ),
    market_size: content(
      'market_size',
      {
        topDown: null,
        bottomUp: {
          customers: { low: 800, high: 1500 },
          revenuePerCustomerEur: { low: 1200, high: 3000 },
          samShare: { low: 60, high: 80 },
          somShare: { low: 25, high: 40 },
          sources: [],
        },
        toClarify: ['There is no reliable study for the overall market. Please ask sales for market data of the industry.'],
      },
      [
        {
          heading: 'Bottom-up assumptions',
          claims: [
            estimate('800 to 1,500 active existing customers order spare parts (assumption from the sales customer count, to be checked).', 'medium'),
            estimate('Spare part revenue per customer and year: 1,200 to 3,000 €.', 'low'),
          ],
        },
        { heading: 'What explains the difference', claims: [assume('Top-down lacks a source; the comparison of both methods is therefore open.')] },
      ],
    ),
    business_case: content(
      'business_case',
      {
        horizonYears: 3,
        assumptions: [
          { id: 'calls', label: 'Fewer calls in the sales office', unit: '€', kind: 'benefit', low: 25000, base: 40000, high: 60000, sources: [] },
          {
            id: 'upsell',
            label: 'Additional revenue (contribution margin) from recommendations',
            unit: '€',
            kind: 'benefit',
            low: 10000,
            base: 30000,
            high: 60000,
            sources: [],
          },
          {
            id: 'build',
            label: 'Portal, ERP connection, data maintenance',
            unit: '€',
            kind: 'one_off_cost',
            low: 35000,
            base: 45000,
            high: 70000,
            sources: [],
          },
          { id: 'run', label: 'Operation, licences, maintenance per year', unit: '€', kind: 'running_cost', low: 8000, base: 12000, high: 18000, sources: [] },
        ],
        toClarify: ['Evaluate call numbers from the phone system for three months.', 'Get offers for part search and shop.'],
      },
      [
        {
          heading: 'Reasons for the assumptions',
          claims: [
            estimate('Savings in the sales office: about 1,000 fewer calls per year at about 40 € full cost per call.', 'low'),
            estimate('Effort of 60 person-days according to the idea profile, plus licences.', 'medium'),
          ],
        },
      ],
    ),
    risk_check: content(
      'risk_check',
      {
        areas: [
          {
            area: 'privacy',
            light: 'yellow',
            finding: 'Customer accounts and order history are personal data. Clarify roles, retention periods and data processing agreements.',
            office: 'Data protection officer',
          },
          {
            area: 'ai_act',
            light: 'green',
            finding: 'Recommendations without automated decisions about people; no high-risk system recognisable.',
            office: 'AI officer or compliance',
          },
          {
            area: 'security',
            light: 'yellow',
            finding: 'Publicly reachable portal with ERP connection: secure access rights and the interface.',
            office: 'Information security',
          },
          { area: 'legal', light: 'yellow', finding: 'Align terms and conditions and prices in the portal with sales.', office: 'Legal department' },
          { area: 'patentability', light: 'green', finding: 'No technical invention recognisable.', office: 'Patent department or patent attorney' },
          { area: 'employee_invention', light: 'green', finding: 'No employee invention recognisable.', office: 'Human resources and patent department' },
        ],
      },
      [],
    ),
    experiment: content(
      'experiment',
      {
        hypothesis:
          'If ten regular customers can order their spare parts through a simple order page by serial number, their calls to the sales office drop by at least a third.',
        smallestTest: 'Order form with a parts list for ten customers and two machine types; the order arrives as a job in the sales office.',
        metric: 'Calls of the test customers per week compared with the four weeks before',
        successCriteria: 'At least 33 % fewer calls and at least 70 % of orders without follow-up questions.',
        durationWeeks: 6,
      },
      [],
    ),
    counterarguments: content(
      'counterarguments',
      {
        counterarguments: [
          { text: 'Many calls need advice because customers do not know the right part; a portal helps little there.', sources: [] },
          { text: 'Without a clean link between serial numbers and parts lists, nobody finds the right part.', sources: [] },
          { text: 'Specialised providers could be faster and cheaper than an own solution.', sources: [1] },
        ],
        premortem:
          'One year later: the portal is online, but few customers use it because the parts cannot be found. Data maintenance was underestimated, and the sales office still takes all calls.',
        earlyWarnings: ['Fewer than half of the test orders get by without follow-up questions.', 'Maintaining the parts data has no owner.'],
      },
      [],
      WEB_SOURCES,
    ),
    dossier_draft: content(
      'dossier_draft',
      {
        summary:
          'A self-service portal for spare parts relieves the sales office and can bring additional revenue. The recommendation is to buy the part search and handle ordering through the ERP; a six-week experiment with ten regular customers checks the benefit first.',
        parts: [
          {
            section: 'benefit',
            content: 'Fewer calls in the sales office and additional revenue; both are estimates, see business case.',
            status: 'filled',
            openQuestions: ['Confirm call numbers from the phone system'],
          },
          { section: 'effort', content: 'About 60 person-days plus licences (estimate).', status: 'filled', openQuestions: [] },
          {
            section: 'risks',
            content: 'Data quality of the serial numbers, privacy of customer accounts, securing the ERP interface.',
            status: 'filled',
            openQuestions: [],
          },
          { section: 'affected', content: 'Sales office, sales, IT, existing customers.', status: 'filled', openQuestions: [] },
          { section: 'path', content: 'Experiment with ten regular customers, then decision on buying the part search.', status: 'filled', openQuestions: [] },
          {
            section: 'analyses',
            content:
              'Short analysis, competition, positioning, market, business case, risks, experiment and counterarguments are available as example building blocks.',
            status: 'filled',
            openQuestions: [],
          },
        ],
        estimates: { effortPersonDays: { low: 50, high: 70 }, effortEuro: { low: 35000, high: 70000 }, planBenefitEuro: { low: 35000, high: 120000 } },
      },
      [],
    ),
  };
}

export function holidayResultsEn(): Record<string, StoredContent> {
  return {
    short_analysis: content(
      'short_analysis',
      {
        summary: 'Leave requests should be submitted digitally and approved with one click. That saves printing, signing and scanning.',
        completeness: { complete: false, missing: ['Number of requests per year'] },
      },
      [
        {
          heading: 'What it is about',
          claims: [assume('Today every request is printed, signed and scanned.'), assume('The line manager should approve with one click.')],
        },
        { heading: 'Similar ideas in the portal', claims: [assume('There is no similar idea in the portal.')] },
        {
          heading: 'Ready-made solutions and how others do it',
          claims: [assume('Many HR and time recording systems have a leave function; first check whether the existing system can already do it.')],
        },
        { heading: 'Market and benefit', claims: [estimate('According to the submission, about 10 minutes less effort per request.', 'low')] },
        { heading: 'Open questions', claims: [assume('Which system does HR use today?')] },
      ],
    ),
    triage_suggestion: content(
      'triage_suggestion',
      {
        lane: 'fast_lane',
        topic: 'Processes and efficiency',
        confidence: 'medium',
        reason: 'Small and clearly feasible if the existing HR system already has the function. Then switching it on is enough.',
        missing: ['Name of the existing HR system'],
      },
      [],
    ),
  };
}

// Request shapes of the three connectors (R3-13 Jira Cloud REST v3, R3-14 ServiceNow Table API,
// R3-15 Azure DevOps Work Items). Pure functions without network: the framework in
// connectors.ts sends the requests through the injectable HTTP client.

export const CONNECTOR_KINDS = ['jira', 'servicenow', 'azure_devops'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export interface ConnectorConfig {
  /** Jira project key or Azure DevOps project; unused for ServiceNow. */
  project: string;
  /** Jira issue type (Epic, Story, Task), ServiceNow table (dmn_demand, pm_project) or Azure DevOps work item type. */
  itemType: string;
  /** Type (or ServiceNow table) of the child items created from the user stories. */
  storyType: string;
  /** ServiceNow: reference field of a story to its parent record. */
  parentField: string;
  fieldMap: { source: FieldSource; target: string }[];
  statusMap: { external: string; progress: number }[];
  /** Ask the target system for the status in the background job (besides callbacks). */
  poll: boolean;
}

export const FIELD_SOURCES = ['number', 'url', 'topic', 'targetDate', 'benefit', 'effortPersonDays', 'effortEuro', 'planBenefitEuro', 'channel'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export type Credentials =
  | { kind: 'jira'; email: string; apiToken: string }
  | { kind: 'servicenow'; username: string; password: string }
  | { kind: 'azure_devops'; pat: string };

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

/** What the portal sends for one item. */
export interface ItemInput {
  role: 'main' | 'story';
  title: string;
  /** Plain text with paragraphs separated by blank lines. */
  description: string;
  /** Link back to the idea in the portal. */
  portalUrl: string;
  ideaId: string;
  ideaNumber: number;
  /** Mapped extra fields (target field id → value). */
  fields: Record<string, string | number>;
}

export interface ExternalItem {
  id: string;
  key: string | null;
  url: string | null;
}

export interface ConnectorTarget {
  kind: ConnectorKind;
  baseUrl: string;
  config: ConnectorConfig;
}

export const DEFAULT_CONFIG: Record<ConnectorKind, Omit<ConnectorConfig, 'project' | 'fieldMap' | 'poll'>> = {
  jira: {
    itemType: 'Epic',
    storyType: 'Story',
    parentField: 'parent',
    statusMap: [
      { external: 'To Do', progress: 10 },
      { external: 'In Progress', progress: 50 },
      { external: 'In Review', progress: 80 },
      { external: 'Done', progress: 100 },
      // Jira status categories as a fallback for custom workflows.
      { external: 'new', progress: 10 },
      { external: 'indeterminate', progress: 50 },
      { external: 'done', progress: 100 },
    ],
  },
  servicenow: {
    itemType: 'dmn_demand',
    storyType: 'rm_story',
    parentField: 'parent',
    statusMap: [
      { external: 'Draft', progress: 0 },
      { external: 'Submitted', progress: 10 },
      { external: 'Screening', progress: 20 },
      { external: 'Qualified', progress: 30 },
      { external: 'Approved', progress: 40 },
      { external: 'Pending', progress: 10 },
      { external: 'Open', progress: 20 },
      { external: 'Work in Progress', progress: 50 },
      { external: 'Completed', progress: 100 },
      { external: 'Closed Complete', progress: 100 },
    ],
  },
  azure_devops: {
    itemType: 'Epic',
    storyType: 'User Story',
    parentField: 'parent',
    statusMap: [
      { external: 'New', progress: 10 },
      { external: 'Active', progress: 50 },
      { external: 'In Progress', progress: 50 },
      { external: 'Resolved', progress: 80 },
      { external: 'Closed', progress: 100 },
      { external: 'Done', progress: 100 },
    ],
  },
};

export const ITEM_TYPES: Record<ConnectorKind, readonly string[]> = {
  jira: ['Epic', 'Story', 'Task'],
  servicenow: ['dmn_demand', 'pm_project'],
  azure_devops: ['Epic', 'Feature', 'User Story'],
};

const base = (t: ConnectorTarget) => t.baseUrl.replace(/\/+$/, '');
const json = { 'content-type': 'application/json', accept: 'application/json' };

export function authHeader(c: Credentials): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  if (c.kind === 'jira') return `Basic ${b64(`${c.email}:${c.apiToken}`)}`;
  if (c.kind === 'servicenow') return `Basic ${b64(`${c.username}:${c.password}`)}`;
  return `Basic ${b64(`:${c.pat}`)}`;
}

const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** Atlassian Document Format for the Jira description. */
export function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs(text).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** HTML for the Azure DevOps description (the field is rich text). */
export const html = (text: string) => paragraphs(text).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

// ---------------------------------------------------------------- create

export function createRequest(t: ConnectorTarget, item: ItemInput, parent: ExternalItem | null): HttpRequest {
  const c = t.config;
  if (t.kind === 'jira') {
    const fields: Record<string, unknown> = {
      project: { key: c.project },
      issuetype: { name: item.role === 'main' ? c.itemType : c.storyType },
      summary: item.title.slice(0, 250),
      description: adf(item.description),
      labels: ['ideenportal'],
      ...item.fields,
    };
    if (parent) fields.parent = { key: parent.key ?? parent.id };
    return { method: 'POST', url: `${base(t)}/rest/api/3/issue`, headers: json, body: JSON.stringify({ fields }) };
  }
  if (t.kind === 'servicenow') {
    const table = item.role === 'main' ? c.itemType : c.storyType;
    const record: Record<string, unknown> = {
      short_description: item.title.slice(0, 160),
      description: item.description,
      // Link back to the portal (both directions, R3-14).
      correlation_id: item.ideaId,
      correlation_display: `Ideenportal #${item.ideaNumber}`, // texts-ok: technical marker
      ...item.fields,
    };
    if (parent) record[c.parentField || 'parent'] = parent.id;
    return { method: 'POST', url: `${base(t)}/api/now/table/${encodeURIComponent(table)}`, headers: json, body: JSON.stringify(record) };
  }
  const type = item.role === 'main' ? c.itemType : c.storyType;
  const ops: { op: 'add'; path: string; value: unknown }[] = [
    { op: 'add', path: '/fields/System.Title', value: item.title.slice(0, 250) },
    { op: 'add', path: '/fields/System.Description', value: html(item.description) },
    { op: 'add', path: '/fields/System.Tags', value: 'Ideenportal' },
    ...Object.entries(item.fields).map(([k, v]) => ({ op: 'add' as const, path: `/fields/${k}`, value: v })),
    { op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: item.portalUrl } },
  ];
  if (parent) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: adoApiUrl(t, parent.id) } });
  return {
    method: 'POST',
    url: `${base(t)}/${encodeURIComponent(c.project)}/_apis/wit/workitems/${encodeURIComponent(`$${type}`)}?api-version=7.1`,
    headers: { 'content-type': 'application/json-patch+json', accept: 'application/json' },
    body: JSON.stringify(ops),
  };
}

const adoApiUrl = (t: ConnectorTarget, id: string) => `${base(t)}/${encodeURIComponent(t.config.project)}/_apis/wit/workItems/${encodeURIComponent(id)}`;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

/** Id, key and link of the created item; null when the answer does not have the expected form. */
export function parseCreated(t: ConnectorTarget, res: HttpResponse, role: 'main' | 'story'): ExternalItem | null {
  const body = obj(res.json);
  if (t.kind === 'jira') {
    const id = str(body.id);
    const key = str(body.key);
    return id && key ? { id, key, url: `${base(t)}/browse/${encodeURIComponent(key)}` } : null;
  }
  if (t.kind === 'servicenow') {
    const r = obj(body.result);
    const id = str(r.sys_id);
    const table = role === 'main' ? t.config.itemType : t.config.storyType;
    return id ? { id, key: str(r.number), url: `${base(t)}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${id}`)}` } : null;
  }
  const id = str(body.id);
  const href = str(obj(obj(obj(body._links).html)).href);
  return id ? { id, key: id, url: href ?? `${base(t)}/${encodeURIComponent(t.config.project)}/_workitems/edit/${id}` } : null;
}

// ---------------------------------------------------------------- status

/** Request for the current status of an item (polling). */
export function statusRequest(t: ConnectorTarget, item: { id: string; key: string | null; role: 'main' | 'story' }): HttpRequest {
  if (t.kind === 'jira') {
    return { method: 'GET', url: `${base(t)}/rest/api/3/issue/${encodeURIComponent(item.key ?? item.id)}?fields=status`, headers: json };
  }
  if (t.kind === 'servicenow') {
    const table = item.role === 'main' ? t.config.itemType : t.config.storyType;
    return { method: 'GET', url: `${base(t)}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(item.id)}?sysparm_fields=state&sysparm_display_value=true`, headers: json };
  }
  return { method: 'GET', url: `${adoApiUrl(t, item.id)}?fields=System.State&api-version=7.1`, headers: json };
}

/** Status names of the answer, most specific first (Jira: status name, then category). */
export function parseStatus(t: ConnectorTarget, res: HttpResponse): string[] {
  const body = obj(res.json);
  if (t.kind === 'jira') return jiraStatus(obj(obj(body.fields).status));
  if (t.kind === 'servicenow') {
    const state = obj(body.result).state;
    return [str(state) ?? str(obj(state).display_value) ?? str(obj(state).value)].filter((s): s is string => !!s);
  }
  return [str(obj(body.fields)['System.State'])].filter((s): s is string => !!s);
}

function jiraStatus(status: Record<string, unknown>): string[] {
  return [str(status.name), str(obj(status.statusCategory).key)].filter((s): s is string => !!s);
}

/** Connection test: a cheap authenticated read. */
export function testRequest(t: ConnectorTarget): HttpRequest {
  if (t.kind === 'jira') return { method: 'GET', url: `${base(t)}/rest/api/3/myself`, headers: json };
  if (t.kind === 'servicenow') return { method: 'GET', url: `${base(t)}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`, headers: json };
  return { method: 'GET', url: `${base(t)}/_apis/projects/${encodeURIComponent(t.config.project)}?api-version=7.1`, headers: json };
}

// ---------------------------------------------------------------- inbound

export interface InboundStatus {
  /** Id or key of the external item. */
  ref: string;
  status: string[];
}

/**
 * Status callback of the target system. Accepted forms: Jira webhook (issue with status),
 * Azure DevOps service hook (workitem.updated / created) and the generic form
 * {"externalId": "...", "status": "..."} (ServiceNow business rule or any script).
 */
export function parseInbound(kind: ConnectorKind, payload: unknown): InboundStatus | null {
  const body = obj(payload);
  const generic = str(body.externalId) ?? str(body.sys_id);
  const genericStatus = str(body.status) ?? str(body.state);
  if (generic && genericStatus) return { ref: generic, status: [genericStatus] };
  if (kind === 'jira') {
    const issue = obj(body.issue);
    const ref = str(issue.key) ?? str(issue.id);
    const status = jiraStatus(obj(obj(issue.fields).status));
    return ref && status.length ? { ref, status } : null;
  }
  if (kind === 'azure_devops') {
    const resource = obj(body.resource);
    const ref = str(resource.workItemId) ?? str(resource.id);
    const fields = obj(resource.fields);
    const changed = obj(fields['System.State']);
    const state = str(changed.newValue) ?? str(fields['System.State']) ?? str(obj(obj(resource.revision).fields)['System.State']);
    return ref && state ? { ref, status: [state] } : null;
  }
  return null;
}

/** Progress for the first status name with an entry in the mapping (case-insensitive). */
export function mapStatus(statusMap: ConnectorConfig['statusMap'], names: string[]): number | null {
  for (const n of names) {
    const hit = statusMap.find((s) => s.external.trim().toLowerCase() === n.trim().toLowerCase());
    if (hit) return hit.progress;
  }
  return null;
}

// ---------------------------------------------------------------- count (R4-04)

/** Placeholders {from} and {to} of a metric query, replaced by the dates of the measured period. */
export function fillPeriod(query: string, from: string, to: string): string {
  return query.replace(/\{from\}/g, from).replace(/\{to\}/g, to);
}

/**
 * Request that counts the items matching a query: Jira approximate count for a JQL, ServiceNow
 * aggregate API for an encoded query, Azure DevOps WIQL (number of returned work items).
 */
export function countRequest(t: ConnectorTarget, query: string, table?: string | null): HttpRequest {
  if (t.kind === 'jira') {
    return { method: 'POST', url: `${base(t)}/rest/api/3/search/approximate-count`, headers: json, body: JSON.stringify({ jql: query }) };
  }
  if (t.kind === 'servicenow') {
    const tbl = table || t.config.itemType;
    return {
      method: 'GET',
      url: `${base(t)}/api/now/stats/${encodeURIComponent(tbl)}?sysparm_count=true&sysparm_query=${encodeURIComponent(query)}`,
      headers: json,
    };
  }
  return {
    method: 'POST',
    url: `${base(t)}/${encodeURIComponent(t.config.project)}/_apis/wit/wiql?api-version=7.1`,
    headers: json,
    body: JSON.stringify({ query }),
  };
}

/** The count of the answer; null when the answer does not have the expected form. */
export function parseCount(t: ConnectorTarget, res: HttpResponse): number | null {
  const body = obj(res.json);
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (t.kind === 'jira') return num(body.count) ?? num(body.total);
  if (t.kind === 'servicenow') return num(obj(obj(body.result).stats).count);
  return Array.isArray(body.workItems) ? body.workItems.length : null;
}

// ---------------------------------------------------------------- tickets for the problem radar (R4-01)

/** What the problem radar reads from a ticket: only title and description, never people. */
export interface TicketText {
  ref: string;
  title: string;
  description: string;
}

export interface TicketQuery {
  /** Jira: JQL; ServiceNow: encoded query; Azure DevOps: work item type (Bug, Issue …). */
  query: string;
  /** ServiceNow table, default incident. */
  table: string;
  days: number;
  max: number;
}

/** Plain text of an Atlassian Document Format value (Jira description). */
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  const n = obj(node);
  if (typeof n.text === 'string') return n.text;
  const parts = Array.isArray(n.content) ? n.content.map(adfText) : [];
  return parts.join(n.type === 'doc' ? '\n\n' : n.type === 'paragraph' ? '' : ' ');
}

const htmlText = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();

/**
 * First request for the tickets of the last `days` days. Only title and description are asked
 * for (Jira fields, ServiceNow sysparm_fields); reporter, assignee and caller stay in the source.
 */
export function ticketRequest(t: ConnectorTarget, q: TicketQuery): HttpRequest {
  const max = Math.max(1, Math.min(q.max, 1000));
  if (t.kind === 'jira') {
    const created = `created >= -${q.days}d`;
    const jql = `${q.query.trim() ? `(${q.query.trim()}) AND ` : ''}${created} ORDER BY created DESC`;
    const url = new URL(`${base(t)}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', 'summary,description');
    url.searchParams.set('maxResults', String(Math.min(max, 100)));
    return { method: 'GET', url: url.toString(), headers: json };
  }
  if (t.kind === 'servicenow') {
    const url = new URL(`${base(t)}/api/now/table/${encodeURIComponent(q.table || 'incident')}`);
    const filter = [q.query.trim(), `sys_created_on>=javascript:gs.daysAgoStart(${q.days})`].filter(Boolean).join('^');
    url.searchParams.set('sysparm_query', `${filter}^ORDERBYDESCsys_created_on`);
    url.searchParams.set('sysparm_fields', 'sys_id,short_description,description');
    url.searchParams.set('sysparm_limit', String(max));
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    return { method: 'GET', url: url.toString(), headers: json };
  }
  const type = q.query.trim().replace(/'/g, '');
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${type ? ` AND [System.WorkItemType] = '${type}'` : ''} AND [System.CreatedDate] >= @today - ${q.days} ORDER BY [System.CreatedDate] DESC`;
  return {
    method: 'POST',
    url: `${base(t)}/${encodeURIComponent(t.config.project)}/_apis/wit/wiql?api-version=7.1&$top=${max}`,
    headers: json,
    body: JSON.stringify({ query: wiql }),
  };
}

/** Azure DevOps: the second request reads title and description of the ids of the query. */
export function adoItemsRequest(t: ConnectorTarget, ids: string[]): HttpRequest {
  const url = `${base(t)}/${encodeURIComponent(t.config.project)}/_apis/wit/workitems?ids=${ids.map(encodeURIComponent).join(',')}&fields=System.Title,System.Description&api-version=7.1`;
  return { method: 'GET', url, headers: json };
}

/** Ids of an Azure DevOps WIQL answer. */
export function parseWiqlIds(res: HttpResponse, max: number): string[] {
  const items = obj(res.json).workItems;
  return (Array.isArray(items) ? items : []).map((w) => str(obj(w).id)).filter((s): s is string => !!s).slice(0, max);
}

/** Title and description of each ticket; every other field of the answer is dropped here. */
export function parseTickets(kind: ConnectorKind, res: HttpResponse): TicketText[] {
  const body = obj(res.json);
  const out: TicketText[] = [];
  if (kind === 'jira') {
    for (const issue of Array.isArray(body.issues) ? body.issues : []) {
      const i = obj(issue);
      const f = obj(i.fields);
      const ref = str(i.key) ?? str(i.id);
      if (ref) out.push({ ref, title: str(f.summary) ?? '', description: f.description ? adfText(f.description) : '' });
    }
  } else if (kind === 'servicenow') {
    for (const row of Array.isArray(body.result) ? body.result : []) {
      const r = obj(row);
      const ref = str(r.sys_id);
      if (ref) out.push({ ref, title: str(r.short_description) ?? '', description: str(r.description) ?? '' });
    }
  } else {
    for (const item of Array.isArray(body.value) ? body.value : []) {
      const w = obj(item);
      const f = obj(w.fields);
      const ref = str(w.id);
      if (ref) out.push({ ref, title: str(f['System.Title']) ?? '', description: htmlText(str(f['System.Description']) ?? '') });
    }
  }
  return out.filter((x) => x.title.trim() || x.description.trim());
}

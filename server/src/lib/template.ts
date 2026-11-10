// Small text template engine for the generated agreements (R3-12). Syntax:
//   {{path.to.value}}                  value; line breaks and "|" are neutralised for tables
//   {{#if path}} … {{else}} … {{/if}}   truthy check (empty arrays count as false)
//   {{#each path}} … {{.field}} … {{/each}}   loop; "{{.}}" is the item itself
// A first line "<!-- template: name, version x -->" carries the template version.

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string }
  | { kind: 'if'; path: string; then: Node[]; else: Node[] }
  | { kind: 'each'; path: string; body: Node[] };

const TAG = /\{\{\s*(#if|#each|else|\/if|\/each)?\s*([^}]*?)\s*\}\}/g;

function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Node | null; list: Node[] }[] = [{ node: null, list: root }];
  let last = 0;
  for (const match of src.matchAll(TAG)) {
    const top = stack[stack.length - 1];
    if (match.index > last) top.list.push({ kind: 'text', text: src.slice(last, match.index) });
    last = match.index + match[0].length;
    const [, op, arg] = match;
    if (!op) top.list.push({ kind: 'var', path: arg });
    else if (op === '#if') {
      const node: Node = { kind: 'if', path: arg, then: [], else: [] };
      top.list.push(node);
      stack.push({ node, list: node.then });
    } else if (op === '#each') {
      const node: Node = { kind: 'each', path: arg, body: [] };
      top.list.push(node);
      stack.push({ node, list: node.body });
    } else if (op === 'else') {
      if (top.node?.kind !== 'if') throw new Error(`template: else outside if at ${match.index}`);
      top.list = top.node.else;
    } else {
      const want = op === '/if' ? 'if' : 'each';
      if (top.node?.kind !== want) throw new Error(`template: unexpected ${op} at ${match.index}`);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new Error('template: unclosed block');
  if (last < src.length) root.push({ kind: 'text', text: src.slice(last) });
  return root;
}

function lookup(scope: unknown[], path: string): unknown {
  if (path === '.') return scope[0];
  const local = path.startsWith('.');
  const keys = (local ? path.slice(1) : path).split('.');
  const starts = local ? [scope[0]] : scope;
  for (const start of starts) {
    let v: unknown = start;
    for (const k of keys) v = v != null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);
const clean = (v: unknown) => (v == null ? '' : String(v).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/'));

function render(nodes: Node[], scope: unknown[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += clean(lookup(scope, n.path));
    else if (n.kind === 'if') out += render(truthy(lookup(scope, n.path)) ? n.then : n.else, scope);
    else {
      const list = lookup(scope, n.path);
      if (Array.isArray(list)) for (const item of list) out += render(n.body, [item, ...scope]);
    }
  }
  return out;
}

export interface Template {
  name: string;
  version: string;
  render: (vars: Record<string, unknown>) => string;
}

export function compileTemplate(src: string): Template {
  const head = /^<!--\s*template:\s*([\w-]+),\s*version\s+([\w.-]+)\s*-->\s*\n/.exec(src);
  if (!head) throw new Error('template: version header missing');
  const nodes = parse(src.slice(head[0].length));
  return {
    name: head[1],
    version: head[2],
    // Blocks leave empty lines behind; more than one blank line in a row is collapsed.
    render: (vars) => render(nodes, [vars]).replace(/\n{3,}/g, '\n\n').trim() + '\n',
  };
}

/**
 * Minimal, STRICT XML reader/writer.
 *
 * Why not a library: project/donor XML is untrusted input. This parser
 *  - rejects DOCTYPE / ENTITY declarations outright (no XXE, no billion-laughs),
 *  - only understands the five predefined entities and numeric character references,
 *  - enforces size, depth and node-count limits,
 *  - reports line/column for every error,
 * and keeps attribute order and child order so documents can be patched and re-emitted
 * without losing anything we do not model (the donor-template workflow).
 */
import { xmlEscape } from '@vfxforge/core';

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Concatenated character data directly inside this element (trimmed). */
  text: string;
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_LIMITS: XmlLimits = { maxBytes: 64 * 1024 * 1024, maxDepth: 64, maxNodes: 2_000_000 };

export class XmlError extends Error {
  constructor(message: string, public readonly line: number, public readonly column: number) {
    super(`XML error at line ${line}, column ${column}: ${message}`);
    this.name = 'XmlError';
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

export function parseXml(source: string, limits: XmlLimits = DEFAULT_LIMITS): XNode {
  if (source.length > limits.maxBytes) throw new XmlError(`document exceeds ${limits.maxBytes} bytes`, 1, 1);
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1; // BOM
  const n = source.length;
  let line = 1;
  let lineStart = 0;
  let nodes = 0;

  const fail = (msg: string): never => {
    throw new XmlError(msg, line, i - lineStart + 1);
  };
  const advanceTo = (end: number) => {
    for (; i < end; i++) {
      if (source.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
  };

  const decode = (raw: string): string => {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
      switch (ref) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 && code !== 9 && code !== 10 && code !== 13 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return fail(`invalid character reference &${ref};`);
      }
      return String.fromCodePoint(code);
    });
  };
  const checkNoStrayAmp = (raw: string) => {
    // any '&' that did not form a valid reference is an (undeclared) entity
    const stripped = raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, '');
    if (stripped.includes('&')) fail('undeclared entity reference (custom entities are not allowed)');
  };

  const skipWs = () => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13) i++;
      else if (c === 10) {
        i++;
        line++;
        lineStart = i;
      } else break;
    }
  };

  const readName = (): string => {
    const start = i;
    if (i >= n || !NAME_START.test(source[i]!)) fail('expected a name');
    while (i < n && NAME_CHAR.test(source[i]!)) i++;
    return source.slice(start, i);
  };

  // prolog: optional XML declaration, comments, whitespace. DOCTYPE is refused.
  let root: XNode | null = null;
  const stack: XNode[] = [];
  const textBuf: string[][] = [];

  while (i < n) {
    if (source[i] === '<') {
      if (source.startsWith('<?', i)) {
        const end = source.indexOf('?>', i + 2);
        if (end < 0) fail('unterminated processing instruction');
        advanceTo(end + 2);
        continue;
      }
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        advanceTo(end + 3);
        continue;
      }
      if (source.startsWith('<!DOCTYPE', i) || source.startsWith('<!ENTITY', i) || source.startsWith('<!ELEMENT', i) || source.startsWith('<!ATTLIST', i)) {
        fail('DOCTYPE/ENTITY declarations are not allowed');
      }
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i + 9);
        if (end < 0) fail('unterminated CDATA section');
        if (stack.length === 0) fail('CDATA outside of the root element');
        textBuf[textBuf.length - 1]!.push(source.slice(i + 9, end));
        advanceTo(end + 3);
        continue;
      }
      if (source.startsWith('</', i)) {
        i += 2;
        const name = readName();
        skipWs();
        if (source[i] !== '>') fail("expected '>' in closing tag");
        i++;
        const open = stack.pop();
        const parts = textBuf.pop();
        if (!open || open.name !== name) fail(`mismatched closing tag </${name}>${open ? `, expected </${open.name}>` : ''}`);
        open!.text = parts!.join('').trim();
        if (stack.length === 0) {
          // only whitespace/comments may follow the root
          skipWs();
          while (i < n) {
            if (source.startsWith('<!--', i)) {
              const end = source.indexOf('-->', i + 4);
              if (end < 0) fail('unterminated comment');
              advanceTo(end + 3);
              skipWs();
            } else fail('content after the root element');
          }
        }
        continue;
      }
      // start tag
      i++;
      const name = readName();
      const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
      let selfClose = false;
      for (;;) {
        skipWs();
        if (i >= n) fail('unterminated start tag');
        if (source[i] === '/') {
          if (source[i + 1] !== '>') fail("expected '>' after '/'");
          i += 2;
          selfClose = true;
          break;
        }
        if (source[i] === '>') {
          i++;
          break;
        }
        const an = readName();
        skipWs();
        if (source[i] !== '=') fail(`attribute ${an} has no value`);
        i++;
        skipWs();
        const quote = source[i];
        if (quote !== '"' && quote !== "'") fail('attribute value must be quoted');
        const end = source.indexOf(quote!, i + 1);
        if (end < 0) fail('unterminated attribute value');
        const raw = source.slice(i + 1, end);
        if (raw.includes('<')) fail("'<' is not allowed in attribute values");
        checkNoStrayAmp(raw);
        if (an in attrs) fail(`duplicate attribute ${an}`);
        attrs[an] = decode(raw);
        advanceTo(end + 1);
      }
      if (++nodes > limits.maxNodes) fail('too many elements');
      if (stack.length >= limits.maxDepth) fail(`nesting deeper than ${limits.maxDepth}`);
      const node: XNode = { name, attrs, children: [], text: '' };
      if (stack.length === 0) {
        if (root) fail('multiple root elements');
        root = node;
      } else {
        stack[stack.length - 1]!.children.push(node);
      }
      if (!selfClose) {
        stack.push(node);
        textBuf.push([]);
      } else if (stack.length === 0) {
        // self-closing root
        skipWs();
        if (i < n) fail('content after the root element');
      }
      continue;
    }
    // character data
    const next = source.indexOf('<', i);
    const end = next < 0 ? n : next;
    const raw = source.slice(i, end);
    if (stack.length === 0) {
      if (raw.trim() !== '') fail('text outside of the root element');
    } else {
      checkNoStrayAmp(raw);
      textBuf[textBuf.length - 1]!.push(decode(raw));
    }
    advanceTo(end);
  }
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]!.name}>`);
  if (!root) fail('document has no root element');
  return root!;
}

/* ------------------------------------------------------------------- writer */

/**
 * Line-oriented writer that emits exactly the shapes CodeWalker's own serializer
 * produces: <Tag value="x" />, <Tag>text</Tag>, <Tag /> for empty strings.
 */
export class XmlWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  open(name: string): this {
    this.lines.push(`${' '.repeat(this.depth)}<${name}>`);
    this.depth++;
    return this;
  }

  close(name: string): this {
    this.depth--;
    this.lines.push(`${' '.repeat(this.depth)}</${name}>`);
    return this;
  }

  /** <Name value="v" /> */
  value(name: string, v: string | number): this {
    this.lines.push(`${' '.repeat(this.depth)}<${name} value="${xmlEscape(String(v))}" />`);
    return this;
  }

  /** <Name>text</Name>, or <Name /> when text is empty. */
  string(name: string, text: string): this {
    const pad = ' '.repeat(this.depth);
    this.lines.push(text === '' ? `${pad}<${name} />` : `${pad}<${name}>${xmlEscape(text)}</${name}>`);
    return this;
  }

  /** <Name x=".." y=".." z=".." /> (third component optional) */
  vec(name: string, v: readonly number[]): this {
    const axes = ['x', 'y', 'z', 'w'];
    const attrs = v.map((c, k) => `${axes[k]}="${fmt(c)}"`).join(' ');
    this.lines.push(`${' '.repeat(this.depth)}<${name} ${attrs} />`);
    return this;
  }

  selfClosing(name: string): this {
    this.lines.push(`${' '.repeat(this.depth)}<${name} />`);
    return this;
  }

  toString(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n${this.lines.join('\n')}\n`;
  }
}

/** Float formatting that round-trips and never emits NaN/Infinity/exponent forms CodeWalker could misread. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Cannot serialise non-finite number ${n}`);
  if (Object.is(n, -0)) return '0';
  const f = Math.fround(n); // the game stores 32-bit floats
  let s = String(f);
  if (/e/i.test(s)) s = f.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/* -------------------------------------------------------- tree (re)serialiser */

/** Serialises a parsed tree back to XML in CodeWalker's shape (used by the donor workflow). */
export function serializeTree(root: XNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const walk = (node: XNode, depth: number) => {
    const pad = ' '.repeat(depth);
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
      .join('');
    if (node.children.length === 0) {
      out.push(node.text === '' ? `${pad}<${node.name}${attrs} />` : `${pad}<${node.name}${attrs}>${xmlEscape(node.text)}</${node.name}>`);
      return;
    }
    out.push(`${pad}<${node.name}${attrs}>`);
    for (const c of node.children) walk(c, depth + 1);
    out.push(`${pad}</${node.name}>`);
  };
  walk(root, 0);
  return out.join('\n') + '\n';
}

export function child(node: XNode, name: string): XNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function childrenOf(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Reads `<Name value="…"/>` (CodeWalker "value" convention) or element text. */
export function valueOf(node: XNode | undefined): string | undefined {
  if (!node) return undefined;
  return node.attrs.value ?? (node.text !== '' ? node.text : undefined);
}

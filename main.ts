// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md sections 1 to 10: the command line,
// output and exit codes, safe paths, format detection, tiered line matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: files as lines ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function createdText(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

// ---- Section 5: matching lines ----

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function normTier(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions >= from where O occurs in lines at this tier. eofOnly: the occurrence ends at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const no = o.map((s) => normTier(s, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normTier(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it occurs at no tier. */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, o, tier, from, eofOnly);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

type BodyItem = { k: 'c' | '-' | '+'; s: string };

function reindent(s: string, f: string, p: string): string {
  if (s.trim() === '') return s;
  return s.startsWith(p) ? f + s.slice(p.length) : s;
}

/** The lines N writes over the O matched at pos: context lines are the file's own, '+' lines re-indented at tier 2. */
function buildReplacement(lines: string[], pos: number, body: BodyItem[], tier: number): string[] {
  const firstO = body.find((b) => b.k !== '+');
  const f = leadWs(lines[pos]!);
  const p = firstO === undefined ? '' : leadWs(firstO.s);
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.k === 'c') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (b.k === '-') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(b.s, f, p) : b.s);
    }
  }
  return out;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyItem[];
  /** a '\' line follows the body's last context or '+' line */
  slashAfterLast: boolean;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no pair; null: /dev/null
  pairNew: string | null | undefined;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  header: boolean; // still before the first hunk
}

function headerPath(raw: string): string | null {
  const t = raw.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) return null;
  return Number(m[1]);
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, pairOld: undefined, pairNew: undefined, renOld: null, renNew: null, newFile: false, delFile: false, hunks: [], header: true };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = cur !== null && cur.header && cur.pairOld === undefined ? cur : newSection();
      s.pairOld = headerPath(line.slice(4).split('\t')[0]!);
      s.pairNew = headerPath(lines[i + 1]!.slice(4).split('\t')[0]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.header) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.header = false;
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyItem[] = [];
      let lastCtxPlusRaw = -1;
      raw.forEach((l, k) => {
        if (l.startsWith('\\')) return;
        const item: BodyItem = l === '' ? { k: 'c', s: '' } : { k: l[0] === ' ' ? 'c' : (l[0] as '-' | '+'), s: l.slice(1) };
        if (item.k !== '-') lastCtxPlusRaw = k;
        body.push(item);
      });
      const slashAfterLast = lastCtxPlusRaw >= 0 && (raw[lastCtxPlusRaw + 1] ?? '').startsWith('\\');
      cur.hunks.push({ a, body, slashAfterLast });
      i = j;
      continue;
    }
    if (cur !== null && cur.header) {
      if (line.startsWith('+++ ')) cur.pairNew = headerPath(line.slice(4).split('\t')[0]!);
      else if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

function sectionEdit(s: USection, strict: boolean, moves: [string, string][]): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : (s.renOld ?? s.gitOld);
  const newPath = s.pairNew !== undefined ? s.pairNew : (s.renNew ?? s.gitNew);
  return (tree) => {
    const creation = oldPath === null || s.newFile;
    const deletion = !creation && (newPath === null || s.delFile);
    if (creation) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const add: string[] = [];
      let slash = false;
      for (const h of s.hunks) {
        for (const b of h.body) if (b.k === '+') add.push(b.s);
        if (h.body.some((b) => b.k === '+')) slash = h.slashAfterLast;
      }
      tree.now.set(p, createdText(add, !slash));
      return;
    }
    if (deletion) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath ?? '';
    const np = newPath ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const move = op !== np;
    if (move && tree.get(np) !== null) throw new Fail('exists', np);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const o = h.body.filter((b) => b.k !== '+').map((b) => b.s);
      const nLen = h.body.filter((b) => b.k !== '-').length;
      if (o.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const add = h.body.filter((b) => b.k === '+').map((b) => b.s);
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...add);
        if (atEnd) f.final = !h.slashAfterLast;
      } else {
        const found = findTier(f.lines, o, 0, strict, false);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let pos = found.pos[0]!;
        for (const cand of found.pos) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        const toEnd = pos + o.length === f.lines.length;
        const rep = buildReplacement(f.lines, pos, h.body, found.tier);
        f.lines.splice(pos, o.length, ...rep);
        if (toEnd) f.final = !h.slashAfterLast;
      }
      d += nLen - o.length;
    }
    const text = joinFile(f);
    if (move) {
      tree.now.set(np, text);
      tree.now.set(op, null);
      moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let afterReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > afterReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, createdText(newLines, true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, 0, strict, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const body: BodyItem[] = [...oldLines.map((s): BodyItem => ({ k: '-', s })), ...newLines.map((s): BodyItem => ({ k: '+', s }))];
      const repLines = buildReplacement(f.lines, pos, body, found.tier);
      f.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    afterReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const raw: { l: string; n: number }[] = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      raw.push({ l: lines[j]!, n: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
    if (kind === 'add') {
      const add: string[] = [];
      for (const r of raw) {
        if (r.l.startsWith('+')) add.push(r.l.slice(1));
        else if (r.l === '') add.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(add, true));
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.l.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.l.slice(13).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r.l.startsWith('@@')) {
          const anchor = r.l.slice(2).trim();
          open = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(open);
        } else if (r.l === '*** End of File') {
          if (open === null) throw new Exit2(`error: parse ${r.n}`);
          open.eof = true;
          open = null;
        } else if (r.l === '' || r.l[0] === ' ' || r.l[0] === '-' || r.l[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.n}`);
            open = { anchor: null, eof: false, body: [] };
            chunks.push(open);
          }
          open.body.push(r.l === '' ? { k: 'c', s: '' } : { k: r.l[0] === ' ' ? 'c' : (r.l[0] as '-' | '+'), s: r.l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.n}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const hit = findTier(f.lines, [ch.anchor], cursor, strict, false);
            if (hit === null) throw new Fail('no-match', path);
            cursor = hit.pos[0]! + 1;
          }
          const o = ch.body.filter((b) => b.k !== '+').map((b) => b.s);
          if (o.length === 0) {
            const add = ch.body.filter((b) => b.k === '+').map((b) => b.s);
            const at = ch.eof ? f.lines.length : cursor;
            f.lines.splice(at, 0, ...add);
            cursor = at + add.length;
          } else {
            const found = findTier(f.lines, o, cursor, strict, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.pos[0]!;
            const repLines = buildReplacement(f.lines, pos, ch.body, found.tier);
            f.lines.splice(pos, o.length, ...repLines);
            cursor = pos + repLines.length;
          }
        }
        const text = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(path, null);
          moves.push([path, moveTo]);
        } else {
          tree.now.set(path, text);
        }
      });
    }
    i = j;
  }
  return edits;
}

// ---- Sections 1, 2, 10: invocation, output, atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [op, np] of moves) {
    if (changed.get(op) === 'D' && changed.get(np) === 'A' && !used.has(op) && !used.has(np)) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      used.add(op);
      used.add(np);
    }
  }
  for (const [p, tag] of changed) {
    if (!used.has(p)) rows.push({ key: p, line: `${tag} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

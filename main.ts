// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: Array<[string, string]> = [];
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

let STRICT = false;

interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function stripTrailWs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function normAt(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrailWs(s);
  let j = 0;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j += 1;
  return stripTrailWs(s.slice(j));
}

function tierList(): number[] {
  return STRICT ? [0] : [0, 1, 2];
}

function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = 0; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (normAt(lines[i + j]!, tier) !== normAt(pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTiered(lines: string[], pat: string[]): { tier: number; positions: number[] } | null {
  for (const t of tierList()) {
    const pos = occurrences(lines, pat, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

function findSingleAt(lines: string[], anchor: string, from: number): number {
  for (const t of tierList()) {
    for (let i = from; i < lines.length; i += 1) {
      if (normAt(lines[i]!, t) === normAt(anchor, t)) return i;
    }
  }
  return -1;
}

function renderNew(fileLines: string[], pos: number, o: string[], n: string[], oCtx: boolean[], nCtx: boolean[], tier: number): string[] {
  const ctxPos: number[] = [];
  for (let i = 0; i < o.length; i += 1) if (oCtx[i]) ctxPos.push(i);
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let seen = 0;
  for (let j = 0; j < n.length; j += 1) {
    if (nCtx[j]) {
      out.push(fileLines[pos + ctxPos[seen]!]!);
      seen += 1;
    } else {
      const s = n[j]!;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    }
  }
  return out;
}

interface HunkLine {
  kind: string;
  text: string;
  backslash: boolean;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  lines: HunkLine[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function cleanUnifiedPath(raw: string): string {
  let s = raw.split('\t')[0]!.trim();
  if (s.startsWith('a/')) s = s.slice(2);
  else if (s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( |$)/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const entries: HunkLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      entries.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), backslash: false, rawEmpty: l === '' });
      j += 1;
    } else if (l[0] === '\\') {
      if (entries.length > 0) entries[entries.length - 1]!.backslash = true;
      j += 1;
    } else break;
  }
  while (entries.length > 0 && entries[entries.length - 1]!.rawEmpty) entries.pop();
  return { hunk: { a, lines: entries }, next: j };
}

function parseUniHeader(lines: string[], i: number, sec: UniSection): number {
  let seenHunk = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (seenHunk) return i;
      if (sec.pairOld === null) {
        sec.pairOld = cleanUnifiedPath(l.slice(4));
        sec.pairNew = cleanUnifiedPath(lines[i + 1]!.slice(4));
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const r = parseHunkBody(lines, i);
      sec.hunks.push(r.hunk);
      seenHunk = true;
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (!seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (!seenHunk) {
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.isNew = true;
      else if (l.startsWith('deleted file mode')) sec.isDeleted = true;
    }
    i += 1;
  }
  return i;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { diffOld: m[1]!, diffNew: m[2]!, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isNew: false, isDeleted: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { diffOld: null, diffNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isNew: false, isDeleted: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => uniEditFor(sec));
}

function applyUniHunks(text: string, hunks: Hunk[], failPath: string): FileDoc {
  let doc = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: string[] = [];
    const oCtx: boolean[] = [];
    const nCtx: boolean[] = [];
    let lastMark: HunkLine | null = null;
    for (const e of h.lines) {
      if (e.kind === ' ' || e.kind === '-') {
        o.push(e.text);
        oCtx.push(e.kind === ' ');
      }
      if (e.kind === ' ' || e.kind === '+') {
        n.push(e.text);
        nCtx.push(e.kind === ' ');
        lastMark = e;
      }
    }
    if (o.length > 0) {
      const found = findTiered(doc.lines, o);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const rep = renderNew(doc.lines, best, o, n, oCtx, nCtx, found.tier);
      const runsToEnd = best + o.length === doc.lines.length;
      const nextLines = [...doc.lines.slice(0, best), ...rep, ...doc.lines.slice(best + o.length)];
      doc = { lines: nextLines, br: doc.br, final: runsToEnd ? !(lastMark !== null && lastMark.backslash) : doc.final };
    } else {
      const at = Math.min(h.a + d, doc.lines.length);
      const runsToEnd = at === doc.lines.length;
      const nextLines = [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at)];
      doc = { lines: nextLines, br: doc.br, final: runsToEnd ? !(lastMark !== null && lastMark.backslash) : doc.final };
    }
    d += n.length - o.length;
  }
  return doc;
}

function uniEditFor(sec: UniSection): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    if (oldP === null && newP === null) return;
    const oldIsNull = oldP === null || oldP === '/dev/null';
    const newIsNull = newP === null || newP === '/dev/null';
    if (sec.isNew || oldIsNull) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      for (const h of sec.hunks) for (const e of h.lines) if (e.kind === '+') outLines.push(e.text);
      let fin = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        let last: HunkLine | null = null;
        for (const e of sec.hunks[hi]!.lines) if (e.kind === '+') last = e;
        if (last !== null) {
          fin = !last.backslash;
          break;
        }
      }
      const text = outLines.length === 0 ? '' : outLines.join('\n') + (fin ? '\n' : '');
      tree.now.set(p, text);
      return;
    }
    if (sec.isDeleted || newIsNull) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const o = oldP!;
      const n = newP!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const doc = applyUniHunks(before, sec.hunks, o);
      tree.now.set(o, null);
      tree.now.set(n, joinFile(doc));
      tree.moves.push([o, n]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = applyUniHunks(before, sec.hunks, p);
    tree.now.set(p, joinFile(doc));
  };
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let rep = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => srEditFor(b));
}

function srEditFor(b: SrBlock): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
      tree.now.set(p, text);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = splitFile(before);
    const found = findTiered(doc.lines, b.oldLines);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const rep = renderNew(doc.lines, pos, b.oldLines, b.newLines, b.oldLines.map(() => false), b.newLines.map(() => false), found.tier);
    const nextLines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile({ lines: nextLines, br: doc.br, final: doc.final }));
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  oCtx: boolean[];
  nCtx: boolean[];
}

interface VSection {
  kind: string;
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: string | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    sections.push(sec);
    i += 1;
    const raw: Array<{ t: string; n: number }> = [];
    while (i < last) {
      const x = lines[i]!;
      if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
      raw.push({ t: x, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.t.trim() === '') raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.t === '') sec.lines.push('');
        else if (r.t[0] === '+') sec.lines.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.n}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
    } else {
      let k = 0;
      if (k < raw.length && raw[k]!.t.startsWith('*** Move to: ')) {
        sec.moveTo = raw[k]!.t.slice(13).trim();
        k += 1;
      }
      let firstChunk = true;
      while (k < raw.length) {
        const x = raw[k]!;
        let anchor: string | null = null;
        if (x.t.startsWith('@@')) {
          anchor = x.t.slice(2).trim();
          if (anchor === '') anchor = null;
          k += 1;
        } else if (!firstChunk) {
          throw new Exit2(`error: parse ${x.n}`);
        }
        const o: string[] = [];
        const n: string[] = [];
        const oCtx: boolean[] = [];
        const nCtx: boolean[] = [];
        let eof = false;
        let anyBody = false;
        let eofLine = 0;
        while (k < raw.length) {
          const y = raw[k]!;
          if (y.t === '*** End of File') {
            eof = true;
            eofLine = y.n;
            k += 1;
            break;
          }
          if (y.t.startsWith('@@')) break;
          if (y.t === '' || y.t[0] === ' ' || y.t[0] === '-' || y.t[0] === '+') {
            anyBody = true;
            const kd = y.t === '' ? ' ' : y.t[0]!;
            const text = y.t === '' ? '' : y.t.slice(1);
            if (kd === ' ' || kd === '-') {
              o.push(text);
              oCtx.push(kd === ' ');
            }
            if (kd === ' ' || kd === '+') {
              n.push(text);
              nCtx.push(kd === ' ');
            }
            k += 1;
          } else {
            throw new Exit2(`error: parse ${y.n}`);
          }
        }
        if (!anyBody && anchor === null) throw new Exit2(`error: parse ${eofLine > 0 ? eofLine : x.n}`);
        sec.chunks.push({ anchor, eof, o, n, oCtx, nCtx });
        firstChunk = false;
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
  }
  return sections.map((sec) => v4aEditFor(sec));
}

function applyVChunks(text: string, chunks: VChunk[], failPath: string): FileDoc {
  let doc = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = findSingleAt(doc.lines, ch.anchor, cursor);
      if (at < 0) throw new Fail('no-match', failPath);
      cursor = at + 1;
    }
    if (ch.o.length > 0) {
      let found: { tier: number; positions: number[] } | null = null;
      for (const t of tierList()) {
        const pos = occurrences(doc.lines, ch.o, t).filter((x) => x >= cursor && (!ch.eof || x + ch.o.length === doc.lines.length));
        if (pos.length > 0) {
          found = { tier: t, positions: pos };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', failPath);
      const pos = found.positions[0]!;
      const rep = renderNew(doc.lines, pos, ch.o, ch.n, ch.oCtx, ch.nCtx, found.tier);
      doc = { lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + ch.o.length)], br: doc.br, final: doc.final };
      cursor = pos + rep.length;
    } else {
      const at = ch.eof ? doc.lines.length : cursor;
      doc = { lines: [...doc.lines.slice(0, at), ...ch.n, ...doc.lines.slice(at)], br: doc.br, final: doc.final };
      cursor = at + ch.n.length;
    }
  }
  return doc;
}

function v4aEditFor(sec: VSection): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const text = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
      tree.now.set(p, text);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = applyVChunks(before, sec.chunks, p);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, joinFile(doc));
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, joinFile(doc));
    }
  };
}

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
  STRICT = strict;
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(o) === null && tree.get(n) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${o}`);
      const ai = rows.findIndex((r) => r.text === `A ${n}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: n, text: `R ${o} -> ${n}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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

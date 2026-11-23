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
  /** Moves an edit performed, in order: the summary prints them as `R old -> new`. */
  readonly moves: Array<{ old: string; new: string }> = [];
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

/** A file split into lines (SPEC.md section 3): its line break, its lines, whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadWs = (s: string): string => s.match(/^[ \t]*/)![0];

/** A line as a tier reads it (section 5): tier 0 exact, tier 1 trailing spaces and tabs off, tier 2 both ends off. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Every 0-based position where old occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  const want = old.map((l) => normLine(l, tier));
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, 1, 2; only 0 when strict) at which old occurs, with its positions. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** The first line at or after `from` equal to one line, at the first tier where one is (section 5, single line). */
function findSingleLine(lines: string[], one: string, from: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(one, t)) return i;
    }
  }
  return null;
}
/** The first occurrence of old at or after `from`, at the first tier with one; an end-of-file search takes only an occurrence ending at the file's last line. */
function findTierFrom(lines: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; at: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, old, t).filter((p) => p >= from && (!eof || p + old.length === lines.length));
    if (occ.length > 0) return { tier: t, at: occ[0]! };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** a `\` line follows this one (section 6) */
  backslash?: boolean;
}
/** The last context or `+` line of a hunk is followed by a `\` line. */
function hunkNoNL(items: BodyLine[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.backslash === true;
  }
  return false;
}
/**
 * The lines that replace a matched occurrence (section 5): a context line is the file's own matched line,
 * a `+` line is written as it is, re-indented at tier 2 from the old first line's leading whitespace to the
 * file's first matched line's.
 */
function buildReplacement(items: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  const old = items.filter((i) => i.kind !== 'add').map((i) => i.text);
  const pLead = old.length > 0 ? leadWs(old[0]!) : '';
  const fLead = leadWs(fileLines[at] ?? '');
  const out: string[] = [];
  let o = 0;
  for (const it of items) {
    if (it.kind === 'del') {
      o += 1;
      continue;
    }
    if (it.kind === 'ctx') {
      out.push(fileLines[at + o]!);
      o += 1;
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
    out.push(t);
  }
  return out;
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

/** Section 6: one unified diff section. A path is undefined when no source named it, null when /dev/null did. */
interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string | null;
  renameNew?: string | null;
  gitOld?: string;
  gitNew?: string;
  create: boolean;
  remove: boolean;
  hunks: UniHunk[];
}
interface UniHunk {
  a: number;
  items: BodyLine[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `---`/`+++` path: the text after the four characters, up to the first tab, spaces removed; /dev/null is no file; a leading a/ or b/ comes off. */
function uniPath(after: string): string | null {
  const p = after.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The hunks of one section, applied in order to a file's text (section 6). */
function applyHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  let s = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((i) => i.kind !== 'add').map((i) => i.text);
    if (O.length === 0) {
      const N = h.items.filter((i) => i.kind === 'add').map((i) => i.text);
      const at = Math.min(Math.max(h.a + d, 0), s.lines.length);
      const atEnd = at === s.lines.length;
      s.lines.splice(at, 0, ...N);
      d += N.length;
      if (atEnd) s.final = !hunkNoNL(h.items);
      continue;
    }
    const found = findTier(s.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.pos[0]!;
    let best = Math.abs(at - target);
    for (const p of found.pos) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        at = p;
      }
    }
    const runsToEnd = at + O.length === s.lines.length;
    const N = buildReplacement(h.items, s.lines, at, found.tier);
    s.lines.splice(at, O.length, ...N);
    d += N.length - O.length;
    if (runsToEnd) s.final = !hunkNoNL(h.items);
  }
  return joinFile(s);
}

/** One unified section as an edit: creation, deletion, move or change of one path. */
function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
  const oldP = oldPath ?? null;
  const newP = newPath ?? null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const adds: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') adds.push(it.text);
      let final = false;
      if (adds.length > 0) {
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          for (let k = h.items.length - 1; k >= 0; k--) {
            if (h.items[k]!.kind === 'add') {
              final = h.items[k]!.backslash !== true;
              break outer;
            }
          }
        }
      }
      tree.now.set(newP, adds.length === 0 ? '' : adds.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (sec.remove || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(tree.get(oldP!)!, sec.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, out);
      tree.moves.push({ old: oldP!, new: newP! });
      return;
    }
    if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
    tree.now.set(oldP!, applyHunks(tree.get(oldP!)!, sec.hunks, strict, oldP!));
  };
}

/** The unified diff's sections (section 6), in patch order. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;
  let inHeader = false;
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text.trim() === '') hunk.items.pop();
        else break;
      }
      hunk = null;
    }
  };
  const startSection = (s: UniSection): void => {
    endBody();
    sec = s;
    sections.push(sec);
    inHeader = true;
  };
  const startHunk = (idx: number): void => {
    const m = lines[idx]!.match(HUNK_HEAD);
    if (m === null || sec === null) throw new Exit2(`error: parse ${idx + 1}`);
    endBody();
    inHeader = false;
    hunk = { a: Number(m[1]), items: [] };
    sec.hunks.push(hunk);
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const next = lines[i + 1];
    if (hunk !== null) {
      if (l.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l[0] === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.backslash = true;
        } else if (l === '') hunk.items.push({ kind: 'ctx', text: '' });
        else hunk.items.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add', text: l.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ gitOld: m[1]!, gitNew: m[2]!, create: false, remove: false, hunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (sec !== null && inHeader) {
        if (sec.pairOld === undefined) {
          sec.pairOld = uniPath(l.slice(4));
          sec.pairNew = uniPath(next.slice(4));
        }
      } else {
        startSection({ pairOld: uniPath(l.slice(4)), pairNew: uniPath(next.slice(4)), create: false, remove: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      startHunk(i);
      i += 1;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && sec.renameOld === undefined) sec.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && sec.renameNew === undefined) sec.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  endBody();
  return sections.map((s) => uniEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (section 7): a creation when the old lines are empty, else one exact occurrence. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const s = splitFile(before);
    const found = findTier(s.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const pLead = leadWs(oldLines[0]!);
    const fLead = leadWs(s.lines[at] ?? '');
    const N = newLines.map((t) => {
      if (found.tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
      return t;
    });
    s.lines.splice(at, oldLines.length, ...N);
    tree.now.set(path, joinFile(s));
  };
}

/** The SEARCH/REPLACE blocks of a patch (section 7), in patch order. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======' && eq < 0) eq = j;
      else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0 || rep < eq) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body lines, whether `*** End of File` anchors it to the file's end. */
interface V4aChunk {
  anchor: string | null;
  items: BodyLine[];
  eof: boolean;
}

/** One V4A Add File section as an edit (section 8). */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as an edit (section 8). */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as an edit (section 8): chunks apply in order under a moving cursor. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const s = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findSingleLine(s.lines, ch.anchor, cursor, strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const O = ch.items.filter((i) => i.kind !== 'add').map((i) => i.text);
      if (O.length === 0) {
        const N = ch.items.filter((i) => i.kind === 'add').map((i) => i.text);
        const at = ch.eof ? s.lines.length : cursor;
        s.lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      const found = findTierFrom(s.lines, O, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const N = buildReplacement(ch.items, s.lines, found.at, found.tier);
      s.lines.splice(found.at, O.length, ...N);
      cursor = found.at + N.length;
    }
    const out = joinFile(s);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

const V4A_FILE = /^\*\*\* (Add|Delete|Update) File: ?(.*)$/;

/** The V4A patch's sections (section 8), in patch order. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => V4A_FILE.test(l) || l.trim() === '*** End Patch';
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const m = l.match(V4A_FILE);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    i += 1;
    if (kind === 'Add') {
      const raw: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const t = raw[k]!;
        if (t === '') fileLines.push('');
        else if (t.startsWith('+')) fileLines.push(t.slice(1));
        else throw new Exit2(`error: parse ${i - raw.length + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (kind === 'Delete') {
      while (i < last) {
        const t = lines[i]!;
        if (blank(t)) {
          i += 1;
          continue;
        }
        if (isSectionStart(t)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    const updLine = i;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i += 1;
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    const endChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const t = lines[i]!;
      if (isSectionStart(t)) break;
      if (t === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        endChunk();
        i += 1;
        continue;
      }
      if (t.startsWith('@@')) {
        endChunk();
        const anchor = t.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
        i += 1;
        continue;
      }
      if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        if (cur === null) cur = { anchor: null, items: [], eof: false };
        if (t === '') cur.items.push({ kind: 'ctx', text: '' });
        else cur.items.push({ kind: t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add', text: t.slice(1) });
        i += 1;
        continue;
      }
      if (blank(t)) {
        if (cur !== null) cur.items.push({ kind: 'ctx', text: t.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    endChunk();
    if (chunks.length > 0) {
      const lc = chunks[chunks.length - 1]!;
      while (lc.items.length > 0) {
        const it = lc.items[lc.items.length - 1]!;
        if (it.kind === 'ctx' && it.text.trim() === '') lc.items.pop();
        else break;
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const rows = new Map<string, { key: string; line: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.delete(mv.old);
      rows.delete(mv.new);
      rows.set(mv.new, { key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))).map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...sorted, `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`] };
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

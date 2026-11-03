/** git unified diff를 줄 단위로 읽어 한 줄 보기와 나란히 보기에 쓴다. */
export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string; old: number | null; new: number | null };
export type Hunk = { header: string; lines: DiffLine[] };

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of patch.split('\n')) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      o = Number(m[1]);
      n = Number(m[2]);
      continue;
    }
    if (!cur || raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    const text = raw.slice(1);
    if (c === '+') cur.lines.push({ kind: 'add', text, old: null, new: n++ });
    else if (c === '-') cur.lines.push({ kind: 'del', text, old: o++, new: null });
    else if (c === ' ') cur.lines.push({ kind: 'ctx', text, old: o++, new: n++ });
  }
  return hunks;
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** 지워진 줄 묶음과 바로 뒤에 추가된 줄 묶음을 같은 높이로 짝지어 나란히 놓는다. */
export function toSplit(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'ctx') { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

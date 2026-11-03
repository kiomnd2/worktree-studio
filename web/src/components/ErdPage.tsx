import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Connection, type EdgeMouseHandler, type NodeChange, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { ErdConfig, ErdFinding, ErdProject, ErdProjectSummary, ErdView, RelationshipType, Session } from '../types';
import TableNode, { type TableNodeType } from './erd/TableNode';
import RelationEdge, { REL_LABEL, type RelationEdgeType } from './erd/RelationEdge';
import Inspector from './erd/Inspector';
import DdlDialog from './erd/DdlDialog';
import DiffPanel from './erd/DiffPanel';
import TableList from './erd/TableList';

/**
 * ERD 다이어그램 화면. 세션 워크스페이스에 연결한 erd-vibe ERD를 그리고 바로 고친다(저장은 erd-vibe에).
 * 위치는 끌어 놓고 0.6초 뒤 묶어서 저장, 컬럼 줄 오른쪽 점(PK 쪽)에서 다른 컬럼 왼쪽 점(FK 쪽)으로 끌면 관계를 만든다.
 */

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

export default function ErdPage(props: { session: Session; initialTable?: string; onBack: () => void; onOpenDict: () => void; onOpenSettings: () => void }) {
  return <ReactFlowProvider><ErdCanvas {...props} /></ReactFlowProvider>;
}

function ErdCanvas({ session, initialTable, onBack, onOpenDict, onOpenSettings }: { session: Session; initialTable?: string; onBack: () => void; onOpenDict: () => void; onOpenSettings: () => void }) {
  const flow = useReactFlow();
  const [config, setConfig] = useState<ErdConfig | null>(null);
  const [projects, setProjects] = useState<ErdProjectSummary[]>([]);
  const [pick, setPick] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ErdView | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyBad, setOnlyBad] = useState(false);
  const [q, setQ] = useState('');
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [ddl, setDdl] = useState<'import' | 'export' | null>(null);
  const [ddlSeed, setDdlSeed] = useState<string | null>(null); // 가져오기에서 미리 고를 워크트리 파일
  const [diffOpen, setDiffOpen] = useState(false);
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  // 보기: 다이어그램 또는 표. 테이블이 많으면 표가 읽기 쉽다.
  const [mode, setMode] = useState<'diagram' | 'table'>(() => (localStorage.getItem('erd.view') === 'table' ? 'table' : 'diagram'));
  useEffect(() => { localStorage.setItem('erd.view', mode); }, [mode]);
  const [expand, setExpand] = useState<{ id: string; n: number } | null>(null); // 표에서 펼쳐 보여 줄 테이블
  const pendingMoves = useRef(new Map<string, { x: number; y: number }>());
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = useRef(new Set<string>());
  const focusedInitial = useRef(false);
  const project = view?.project ?? null;

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const v = await api.erdView(session.id, { project: pick, refresh });
      setView(v); setLoadedAt(Date.now()); setError(null);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [session.id, pick]);
  useEffect(() => {
    api.erdConfig().then((c) => {
      setConfig(c);
      if (!c.configured) { setLoading(false); return; }
      api.erdProjects().then(setProjects).catch(() => {});
      load();
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, [load]);
  useServerEvents((e) => {
    if (e.type === 'erd.updated' && project && e.projectId === project.id && pendingMoves.current.size === 0) load();
    if (e.type === 'dict.updated') load();
  });
  // 편집 API가 돌려준 최신 ERD로 바꾼다(판정은 다음 새로 받기 때 다시 계산되므로 바로 다시 받는다).
  const applyProject = useCallback((p: ErdProject) => { setView((v) => (v ? { ...v, project: p } : v)); load(); }, [load]);

  const findingsByTable = useMemo(() => {
    const m = new Map<string, Map<string, ErdFinding>>();
    for (const f of view?.findings ?? []) {
      const t = f.table.toUpperCase();
      if (!m.has(t)) m.set(t, new Map());
      m.get(t)!.set(f.column.toUpperCase(), f);
    }
    return m;
  }, [view]);
  const badCount = (tName: string) => [...(findingsByTable.get(tName.toUpperCase())?.values() ?? [])].filter((f) => f.issues.some((i) => i !== 'no_term_link')).length;
  const totalBad = useMemo(() => (project?.tables ?? []).filter((t) => badCount(t.physical_name) > 0).length, [project, findingsByTable]); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = q.trim().toUpperCase();
  const matches = useMemo(() => !needle || !project ? [] : project.tables.filter((t) => t.physical_name.toUpperCase().includes(needle) || t.logical_name.toUpperCase().includes(needle)
    || t.columns.some((c) => c.physical_name.toUpperCase().includes(needle) || c.logical_name.toUpperCase().includes(needle))).slice(0, 10), [needle, project]);
  const matchedIds = useMemo(() => new Set(matches.map((t) => t.id)), [matches]);

  // ERD가 바뀌면 노드를 다시 만든다. 저장하지 않은 끌기 위치는 그대로 둔다.
  useEffect(() => {
    if (!project) { setNodes([]); return; }
    setNodes(project.tables.map((t) => {
      const moved = pendingMoves.current.get(t.id);
      const findings = findingsByTable.get(t.physical_name.toUpperCase()) ?? new Map<string, ErdFinding>();
      return {
        id: t.id, type: 'table', position: moved ?? { x: t.position_x ?? 0, y: t.position_y ?? 0 },
        data: { table: t, findings, dim: onlyBad && badCount(t.physical_name) === 0, selected: selected === t.id, matched: matchedIds.has(t.id) },
      };
    }));
  }, [project, findingsByTable, onlyBad, selected, matchedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const edges = useMemo<RelationEdgeType[]>(() => (project?.relationships ?? []).map((r) => {
    const from = project!.tables.find((t) => t.id === r.from_table_id);
    const to = project!.tables.find((t) => t.id === r.to_table_id);
    const dim = onlyBad && Boolean(from && to) && badCount(from!.physical_name) === 0 && badCount(to!.physical_name) === 0;
    return {
      id: r.id, type: 'relation', source: r.from_table_id, target: r.to_table_id, sourceHandle: `${r.from_column_id}-s`, targetHandle: `${r.to_column_id}-t`,
      data: { type: r.relationship_type, dim }, selected: edgeMenu?.id === r.id, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    };
  }), [project, onlyBad, edgeMenu, findingsByTable]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusTable = useCallback((id: string) => {
    setSelected(id);
    if (mode === 'table') { setExpand({ id, n: Date.now() }); return; }
    const n = flow.getNode(id);
    if (n) flow.setCenter(n.position.x + (n.measured?.width ?? 240) / 2, n.position.y + (n.measured?.height ?? 160) / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 300 });
  }, [flow, mode]);
  // 다른 화면에서 "ERD에서 보기"로 왔으면 그 테이블로
  useEffect(() => {
    if (focusedInitial.current || !initialTable || !project || nodes.length === 0) return;
    const t = project.tables.find((x) => x.physical_name.toUpperCase() === initialTable.toUpperCase());
    focusedInitial.current = true;
    if (t) setTimeout(() => focusTable(t.id), 50);
  }, [initialTable, project, nodes.length, focusTable]);

  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const flushMoves = useCallback(async () => {
    if (!project || pendingMoves.current.size === 0) return;
    const moves = [...pendingMoves.current.entries()].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) }));
    pendingMoves.current.clear();
    moves.forEach((m) => touched.current.add(m.id));
    try { await api.erdMoveTables(project.id, moves); } catch (e) { setError(`위치를 저장하지 못했습니다: ${(e as Error).message}`); load(); }
  }, [project, load]);
  const onNodeDragStop = useCallback((_: unknown, _n: TableNodeType, dragged: TableNodeType[]) => {
    for (const n of dragged) pendingMoves.current.set(n.id, n.position);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(flushMoves, 600);
  }, [flushMoves]);
  useEffect(() => () => { if (moveTimer.current) { clearTimeout(moveTimer.current); flushMoves(); } }, [flushMoves]);

  const onConnect = useCallback(async (c: Connection) => {
    if (!project || !c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    try {
      const res = await api.erdAddRelationship(project.id, {
        from_table_id: c.source, from_column_id: c.sourceHandle.replace(/-s$/, ''), to_table_id: c.target, to_column_id: c.targetHandle.replace(/-t$/, ''), relationship_type: 'one_to_many',
      });
      applyProject(res.project);
    } catch (e) { setError((e as Error).message); }
  }, [project, applyProject]);
  const onEdgeClick: EdgeMouseHandler<RelationEdgeType> = useCallback((e, edge) => { setEdgeMenu({ id: edge.id, x: e.clientX, y: e.clientY }); }, []);
  const onNodeClick: NodeMouseHandler<TableNodeType> = useCallback((_, n) => { setSelected(n.id); setEdgeMenu(null); }, []);
  const setRelType = async (rid: string, t: RelationshipType) => {
    setEdgeMenu(null);
    try { applyProject((await api.erdUpdateRelationship(project!.id, rid, t)).project); } catch (e) { setError((e as Error).message); }
  };
  const deleteRel = async (rid: string) => {
    setEdgeMenu(null);
    if (!confirm('이 관계를 지울까요?')) return;
    try { applyProject((await api.erdDeleteRelationship(project!.id, rid)).project); } catch (e) { setError((e as Error).message); }
  };

  const addTable = async () => {
    if (!project) return;
    const name = prompt('새 테이블 물리명(영문·숫자·밑줄)', 'TB_')?.trim().toUpperCase();
    if (!name) return;
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { setError('테이블 물리명은 영문·숫자·밑줄만 씁니다.'); return; }
    if (project.tables.some((t) => t.physical_name.toUpperCase() === name)) { setError(`이미 있는 테이블입니다: ${name}`); return; }
    const logical = prompt('논리명', '')?.trim();
    if (logical === undefined) return;
    // 표 보기에는 캔버스가 없으니 맨 오른쪽 테이블 옆에 놓는다.
    const el = mode === 'diagram' ? document.querySelector('.erd-canvas')?.getBoundingClientRect() : undefined;
    const center = el ? flow.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 })
      : { x: project.tables.length ? Math.max(...project.tables.map((t) => t.position_x ?? 0)) + 350 : 100, y: 100 };
    try {
      const res = await api.erdCreateTable(project.id, { physical_name: name, logical_name: logical || name, position_x: Math.round(center.x), position_y: Math.round(center.y) });
      applyProject(res.project);
      focusTable(res.created_id);
    } catch (e) { setError((e as Error).message); }
  };
  const autoLayout = async () => {
    if (!project || !confirm('테이블 위치를 모두 자동으로 다시 놓을까요? 팀이 같이 보는 ERD의 배치가 바뀝니다.')) return;
    try { applyProject((await api.erdAutoLayout(project.id)).project); setTimeout(() => flow.fitView({ duration: 300 }), 100); } catch (e) { setError((e as Error).message); }
  };
  const newProject = async () => {
    const name = prompt('새 ERD 이름', session.ticket)?.trim();
    if (!name) return;
    try {
      const p = await api.createErdProject(name);
      setProjects((ps) => [p, ...ps]);
      setPick(p.id);
    } catch (e) { setError((e as Error).message); }
  };

  if (config && !config.configured) {
    return (
      <main className="main empty">
        <div><h1>ERD</h1><p>erd-vibe 연동이 설정되지 않았습니다.</p><div className="row"><button className="primary" onClick={onOpenSettings}>설정 열기</button><button onClick={onBack}>세션 화면으로</button></div></div>
      </main>
    );
  }
  const table = project?.tables.find((t) => t.id === selected) ?? null;
  const ago = loadedAt ? Math.max(0, Math.round((Date.now() - loadedAt) / 60000)) : null;
  const projectSelect = (
    <select aria-label="ERD 프로젝트" value={pick ?? view?.linked_id ?? ''} onChange={(e) => { if (e.target.value === '__new') newProject(); else { setPick(e.target.value || undefined); setSelected(null); } }}>
      {!view?.linked_id && !pick && <option value="">ERD 고르기</option>}
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === view?.linked_id ? ' (연결됨)' : ''}</option>)}
      <option value="__new">＋ 새 ERD 만들기</option>
    </select>
  );
  // 이 화면에서 고른 ERD를 세션 워크스페이스에 바로 연결한다(설정 > erd-vibe 용어사전의 워크스페이스별 ERD와 같다).
  const linkPick = async () => {
    if (!pick) return;
    try { await api.setWorkspaceErd(session.workspace_id, pick); setPick(undefined); }
    catch (e) { setError((e as Error).message); }
  };
  const linkButton = pick && pick !== view?.linked_id
    ? <button className="primary" onClick={linkPick}>{session.workspace_name} 워크스페이스에 연결</button> : null;
  const edgeRel = edgeMenu ? project?.relationships.find((r) => r.id === edgeMenu.id) : undefined;

  return (
    <main className="main erd-page">
      <div className="erd-toolbar">
        <div className="row">
          <b>ERD</b>{projectSelect}{project && linkButton}
          {project && <span className="muted small">{project.dbms_type} · 테이블 {project.tables.length} · 관계 {project.relationships.length}{ago !== null ? ` · 받은 지 ${ago ? `${ago}분` : '방금'}` : ''}</span>}
          <span className="spacer" />
          <button onClick={onOpenDict}>용어 화면</button>
          {view && <a className="btn-link" href={view.web_url} target="_blank" rel="noreferrer">erd-vibe에서 열기</a>}
          <button onClick={onBack}>세션 화면으로</button>
        </div>
        {project && (
          <div className="row">
            <div className="seg" role="group" aria-label="보기">
              <button className={`chip-btn${mode === 'diagram' ? ' on' : ''}`} aria-pressed={mode === 'diagram'} onClick={() => setMode('diagram')}>다이어그램</button>
              <button className={`chip-btn${mode === 'table' ? ' on' : ''}`} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>표</button>
            </div>
            <div className="erd-search">
              <input placeholder="테이블·컬럼 찾기" value={q} onChange={(e) => setQ(e.target.value)} aria-label="테이블·컬럼 찾기"
                onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { focusTable(matches[0].id); } if (e.key === 'Escape') setQ(''); }} />
              {mode === 'diagram' && matches.length > 0 && (
                <ul className="erd-search-list">
                  {matches.map((t) => <li key={t.id}><button onClick={() => { focusTable(t.id); setQ(''); }}><span className="mono">{t.physical_name}</span> <span className="muted small">{t.logical_name}</span></button></li>)}
                </ul>
              )}
            </div>
            <button onClick={addTable} disabled={loading}>＋ 테이블</button>
            {mode === 'diagram' && <button onClick={autoLayout} disabled={loading}>자동 정렬</button>}
            <button onClick={() => load(true)} disabled={loading}>{loading ? <><span className="spinner" aria-hidden="true" /> 받는 중</> : '↻ 새로 받기'}</button>
            <span className="erd-sep" />
            <button onClick={() => { setDdlSeed(null); setDdl('import'); }}>DDL 가져오기</button>
            <button onClick={() => setDdl('export')}>DDL 내보내기</button>
            <button className={diffOpen ? 'chip-on' : ''} aria-pressed={diffOpen} onClick={() => setDiffOpen((v) => !v)}>소스와 비교</button>
            <span className="spacer" />
            <button className={onlyBad ? 'chip-on' : ''} aria-pressed={onlyBad} onClick={() => setOnlyBad((v) => !v)}>⚠ 위반만 ({totalBad})</button>
          </div>
        )}
      </div>
      {error && <p className="banner error erd-banner" role="alert">{error} <button className="small-btn" onClick={() => setError(null)}>닫기</button></p>}

      {!view && loading && <div className="erd-empty"><p className="muted"><span className="spinner" aria-hidden="true" /> ERD 불러오는 중…</p></div>}
      {view && !project && (
        <div className="erd-empty">
          <p><b>{session.workspace_name}</b> 워크스페이스에 연결된 ERD가 없습니다. ERD 연결은 워크스페이스마다 따로 합니다.</p>
          <div className="row">{projectSelect}{linkButton ?? <button onClick={onOpenSettings}>설정에서 연결하기</button>}</div>
        </div>
      )}
      {project && (
        <div className="erd-body">
          <div className="erd-main">
            <div className="erd-canvas">
              {project.tables.length === 0 ? (
                <div className="erd-empty">
                  <p>테이블이 없습니다.</p>
                  <div className="row"><button onClick={addTable}>＋ 테이블</button><button onClick={() => setDdl('import')}>DDL 가져오기</button></div>
                </div>
              ) : mode === 'table' ? (
                <TableList project={project} view={view!} findingsByTable={findingsByTable} needle={needle} onlyBad={onlyBad}
                  selected={selected} expandId={expand} onSelect={setSelected} onClearFilters={() => { setQ(''); setOnlyBad(false); }} />
              ) : (
                <ReactFlow<TableNodeType, RelationEdgeType>
                  nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onConnect={onConnect}
                  onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={() => { setSelected(null); setEdgeMenu(null); }}
                  nodesConnectable elementsSelectable={false} fitView minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}
                >
                  <Background gap={20} />
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable nodeColor={(n) => ((n.data as { dim?: boolean }).dim ? '#D6DBE2' : '#9AA4B3')} />
                </ReactFlow>
              )}
              {edgeMenu && edgeRel && (
                <div className="erd-edge-menu" style={{ left: edgeMenu.x, top: edgeMenu.y }} role="menu">
                  {(Object.keys(REL_LABEL) as RelationshipType[]).map((t) => (
                    <button key={t} role="menuitemradio" aria-checked={edgeRel.relationship_type === t} className={edgeRel.relationship_type === t ? 'on' : ''} onClick={() => setRelType(edgeRel.id, t)}>{REL_LABEL[t]}</button>
                  ))}
                  <button role="menuitem" className="danger" onClick={() => deleteRel(edgeRel.id)}>관계 삭제</button>
                </div>
              )}
            </div>
            {diffOpen && (
              <DiffPanel session={session} project={project} onSelect={(name) => { const t = project.tables.find((x) => x.physical_name.toUpperCase() === name.toUpperCase()); if (t) focusTable(t.id); }}
                onImport={(file) => { setDdlSeed(file); setDdl('import'); }} onClose={() => setDiffOpen(false)} />
            )}
          </div>
          {table ? (
            <Inspector key={table.id} session={session} project={project} view={view!} table={table} findings={findingsByTable.get(table.physical_name.toUpperCase()) ?? new Map()}
              ownTouched={(id) => { const had = touched.current.has(id); touched.current.delete(id); return had; }}
              onSaved={applyProject} onReload={() => load(true)} onDeleted={(p) => { setSelected(null); applyProject(p); }} />
          ) : (
            <aside className="erd-inspector">
              <h2>{project.name}</h2>
              {project.description && <p className="muted small">{project.description}</p>}
              <div className="row">
                <span className="pill accent">{project.dbms_type}</span><span className="pill">테이블 {project.tables.length}</span>
                <span className={`pill ${view!.findings.length ? 'warn' : 'ok'}`}>컬럼 위반 {view!.findings.length}</span>
              </div>
              <p className="muted small">테이블을 누르면 여기서 이름·컬럼을 고칩니다. 컬럼 줄 오른쪽 점에서 다른 테이블 컬럼의 왼쪽 점으로 끌면 관계(1:N)를 만듭니다.</p>
              {totalBad > 0 && (
                <>
                  <h3>위반이 있는 테이블</h3>
                  <ul className="erd-badlist">
                    {project.tables.filter((t) => badCount(t.physical_name) > 0).map((t) => (
                      <li key={t.id}><button onClick={() => focusTable(t.id)}><span className="mono">{t.physical_name}</span> <span className="panel-menu-count bad">{badCount(t.physical_name)}</span></button></li>
                    ))}
                  </ul>
                </>
              )}
            </aside>
          )}
        </div>
      )}
      {ddl && project && (
        <DdlDialog session={session} project={project} mode={ddl} seedFile={ddlSeed} selectedId={selected}
          onApplied={(p) => applyProject(p)} onClose={() => { setDdl(null); setDdlSeed(null); }} />
      )}
    </main>
  );
}

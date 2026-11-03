import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ErdFinding, ErdTable } from '../../types';

/** 캔버스의 테이블 하나. 컬럼 줄마다 왼쪽(받는 쪽, FK)·오른쪽(주는 쪽, PK) 연결점이 있다. */
export type TableNodeData = { table: ErdTable; findings: Map<string, ErdFinding>; dim: boolean; selected: boolean; matched: boolean };
export type TableNodeType = Node<TableNodeData, 'table'>;

export const colType = (c: { data_type: string | null; data_length: string | number | null }) =>
  c.data_type ? (c.data_length && !c.data_type.includes('(') ? `${c.data_type}(${c.data_length})` : c.data_type) : '';

function TableNode({ data }: NodeProps<TableNodeType>) {
  const { table, findings, dim, selected, matched } = data;
  const cols = [...table.columns].sort((a, b) => a.order_index - b.order_index);
  return (
    <div className={`erd-node${dim ? ' dim' : ''}${selected ? ' on' : ''}${matched ? ' matched' : ''}`}>
      <div className="erd-node-head" style={table.header_color ? { background: table.header_color } : undefined}>
        <b className="mono">{table.physical_name}</b> <span>{table.logical_name}</span>
      </div>
      <ul>
        {cols.map((c) => {
          const f = findings.get(c.physical_name.toUpperCase());
          const bad = f?.issues.some((i) => i !== 'no_term_link');
          return (
            <li key={c.id} className={bad ? 'bad' : f ? 'nolink' : ''} title={f ? f.issues.join(', ') : c.logical_name}>
              <Handle type="target" position={Position.Left} id={`${c.id}-t`} />
              <span className="erd-pk">{c.is_primary_key ? '🔑' : ''}</span>
              <span className="mono erd-col">{c.physical_name}</span>
              <span className="mono muted erd-type">{colType(c)}</span>
              {bad && <span className="erd-flag" aria-label="위반">⚠</span>}
              <Handle type="source" position={Position.Right} id={`${c.id}-s`} />
            </li>
          );
        })}
        {cols.length === 0 && <li className="muted small">컬럼 없음</li>}
      </ul>
    </div>
  );
}

export default memo(TableNode);

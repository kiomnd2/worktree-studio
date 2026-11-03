import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { RelationshipType } from '../../types';

/** 관계선. from(PK 쪽) → to(FK 쪽). 가운데에 1:N 같은 종류를 적고, 누르면 ErdPage가 메뉴를 연다. */
export type RelationEdgeData = { type: RelationshipType; dim: boolean };
export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;
export const REL_LABEL: Record<RelationshipType, string> = { one_to_one: '1 : 1', one_to_many: '1 : N', many_to_many: 'N : M' };

function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<RelationEdgeType>) {
  const [path, x, y] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`erd-edge${selected ? ' on' : ''}${data?.dim ? ' dim' : ''}`} />
      <EdgeLabelRenderer>
        <div className={`erd-edge-label nodrag nopan${selected ? ' on' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
          {data ? REL_LABEL[data.type] : ''}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(RelationEdge);

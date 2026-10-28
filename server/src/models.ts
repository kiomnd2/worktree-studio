import { getSettings } from './settings.js';

// 대화와 보조 호출(PR 문안, 화면 분석 등)의 모델. 보조 호출은 설정에서 호출마다 고르고, 고르지 않으면 대화 모델을, 그것도 없으면 Claude Code 기본 모델을 쓴다.
export const HELPER_PURPOSES = ['pr_draft', 'ticket_draft', 'screens', 'test_cases', 'test_run', 'env_scan', 'env_suggest', 'project_analyze', 'conflict'] as const;
export type HelperPurpose = (typeof HELPER_PURPOSES)[number];

export function chatModel(): string | undefined {
  return getSettings().defaultModel || undefined;
}

export function helperModel(purpose: HelperPurpose): string | undefined {
  const s = getSettings();
  return s.helperModels[purpose] || s.defaultModel || undefined;
}

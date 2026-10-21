import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UsageReport, UsageSum } from '../types';
import { HELPER_TASKS } from './SettingsPage';

const RANGES = [
  { days: 1, label: '오늘' },
  { days: 7, label: '7일' },
  { days: 30, label: '30일' },
  { days: 0, label: '전체' },
];
const PURPOSE: Record<string, string> = { chat: '세션 대화', ...Object.fromEntries(HELPER_TASKS.map((t) => [t.key, t.label])) };

const usd = (n: number) => `$${n < 10 ? n.toFixed(3) : n.toFixed(2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

function SumCells({ s }: { s: UsageSum }) {
  return (
    <>
      <td className="num">{s.calls}</td>
      <td className="num">{tok(s.input)}</td>
      <td className="num">{tok(s.output)}</td>
      <td className="num">{tok(s.cache_read)} / {tok(s.cache_write)}</td>
      <td className="num strong">{usd(s.cost_usd)}</td>
    </>
  );
}
const SUM_HEAD = <><th className="num">호출</th><th className="num">입력</th><th className="num">출력</th><th className="num">캐시 읽기 / 쓰기</th><th className="num">비용</th></>;

/**
 * Claude 호출(세션 대화와 보조 호출)의 토큰·비용. 비용은 SDK가 알려 준 추정값이라 실제 청구와 다를 수 있다.
 */
export default function UsagePage({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => { setError(null); api.usage(days).then(setReport).catch((e) => setError(e.message)); };
  useEffect(reload, [days]);

  const t = report?.totals;
  const maxDay = Math.max(0, ...(report?.by_day ?? []).map((d) => d.cost_usd));

  return (
    <main className="main scroll">
      <div className="settings usage">
        <div className="page-head">
          <div>
            <p className="muted small">Claude 토큰·비용 추정</p>
            <h1>사용량 보고서</h1>
          </div>
          <div className="row">
            <div className="segmented" role="group" aria-label="기간">
              {RANGES.map((r) => (
                <button key={r.days} aria-pressed={days === r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>{r.label}</button>
              ))}
            </div>
            <button onClick={reload}>새로고침</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        {!report && !error && <p className="muted small">불러오는 중</p>}
        {report && t && (
          <>
            <div className="usage-stats">
              <div className="card usage-stat"><span className="muted small">비용</span><strong>{usd(t.cost_usd)}</strong></div>
              <div className="card usage-stat"><span className="muted small">호출</span><strong>{t.calls}</strong>{t.errors > 0 && <span className="warn-text small">오류 {t.errors}</span>}</div>
              <div className="card usage-stat"><span className="muted small">입력 · 출력 토큰</span><strong>{tok(t.input)} · {tok(t.output)}</strong></div>
              <div className="card usage-stat"><span className="muted small">캐시 읽기 · 쓰기</span><strong>{tok(t.cache_read)} · {tok(t.cache_write)}</strong></div>
            </div>
            <p className="muted small">
              비용은 Claude가 알려 준 추정값이라 실제 청구와 다를 수 있습니다.
              {report.carried > 0 && ` 기록을 시작하기 전부터 이어 온 대화 ${report.carried}건은 예전 사용량이 섞여 있어 뺐습니다.`}
            </p>

            {t.calls === 0 ? (
              <div className="card"><p>이 기간에 기록된 사용량이 없습니다.</p></div>
            ) : (
              <>
                <section className="card">
                  <div className="card-head"><h2>용도별</h2></div>
                  <div className="table-wrap">
                    <table className="usage-table">
                      <thead><tr><th>용도</th>{SUM_HEAD}</tr></thead>
                      <tbody>{report.by_purpose.map((r) => <tr key={r.purpose}><td>{PURPOSE[r.purpose] ?? r.purpose}</td><SumCells s={r} /></tr>)}</tbody>
                    </table>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head"><h2>모델별</h2></div>
                  <div className="table-wrap">
                    <table className="usage-table">
                      <thead><tr><th>모델</th>{SUM_HEAD}</tr></thead>
                      <tbody>{report.by_model.map((r) => <tr key={r.model}><td><code>{r.model}</code></td><SumCells s={r} /></tr>)}</tbody>
                    </table>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head"><h2>세션별</h2><p className="muted small">비용이 큰 순서로 30개까지</p></div>
                  <div className="table-wrap">
                    <table className="usage-table">
                      <thead><tr><th>세션</th>{SUM_HEAD}</tr></thead>
                      <tbody>
                        {report.by_session.length === 0 && <tr><td colSpan={6} className="muted">세션에 묶인 사용량이 없습니다.</td></tr>}
                        {report.by_session.map((r) => (
                          <tr key={r.session_id}>
                            <td>
                              {r.closed ? <strong>{r.ticket}</strong> : <button className="link strong" onClick={() => onOpenSession(r.session_id)}>{r.ticket}</button>}
                              <div className="muted small">{r.summary || '요약 없음'} · {r.workspace_name}{r.closed ? ' · 닫힘' : ''}</div>
                            </td>
                            <SumCells s={r} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head"><h2>날짜별</h2></div>
                  <div className="table-wrap">
                    <table className="usage-table">
                      <thead><tr><th>날짜</th><th className="usage-bar-col"><span className="sr-only">비용 막대</span></th>{SUM_HEAD}</tr></thead>
                      <tbody>
                        {report.by_day.map((r) => (
                          <tr key={r.day}>
                            <td>{r.day}</td>
                            <td className="usage-bar-col"><span className="usage-bar" style={{ width: `${maxDay ? (r.cost_usd / maxDay) * 100 : 0}%` }} /></td>
                            <SumCells s={r} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

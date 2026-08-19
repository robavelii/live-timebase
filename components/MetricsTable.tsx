import type { Metrics } from '@/lib/metrics'

/**
 * Every row is error measured against **program-date-time** — the distance between
 * the picture a follower is showing and the picture the lead is showing, in absolute
 * time. Not the distance between their playheads, which is the mistake under
 * examination and would score command mirroring as perfect while it displayed a
 * moment ten seconds adrift.
 */
export function MetricsTable({
  timebase,
  syncwave,
}: {
  timebase: Metrics
  syncwave: Metrics
}) {
  const rows: {
    label: string
    tb: number
    sw: number
    format?: (v: number) => string
    better?: 'lower' | 'higher'
    note?: string
  }[] = [
    { label: 'Samples', tb: timebase.samples, sw: syncwave.samples, format: String, better: 'higher' },
    { label: 'p50 error', tb: timebase.p50Ms, sw: syncwave.p50Ms },
    { label: 'p95 error', tb: timebase.p95Ms, sw: syncwave.p95Ms },
    { label: 'p99 error', tb: timebase.p99Ms, sw: syncwave.p99Ms },
    { label: 'max error', tb: timebase.maxMs, sw: syncwave.maxMs },
    {
      label: 'mean signed',
      tb: timebase.meanSignedMs,
      sw: syncwave.meanSignedMs,
      note: 'non-zero is a systematic bias, not noise',
    },
    {
      label: 'frame-accurate',
      tb: timebase.frameAccuratePct,
      sw: syncwave.frameAccuratePct,
      format: (v) => `${v.toFixed(1)}%`,
      better: 'higher',
      note: 'inside 40 ms — one frame at 25 fps',
    },
    {
      label: 'beyond QC 250 ms',
      tb: timebase.beyondQcPct,
      sw: syncwave.beyondQcPct,
      format: (v) => `${v.toFixed(1)}%`,
    },
    {
      label: 'duel window eaten',
      tb: timebase.duelWindowConsumedPct,
      sw: syncwave.duelWindowConsumedPct,
      format: (v) => `${v.toFixed(1)}%`,
      note: 'share of the ±2 s pairing window consumed at p95',
    },
    {
      label: 'samples mid-reposition',
      tb: timebase.hardSeeks,
      sw: syncwave.hardSeeks,
      format: String,
      note: 'samples taken while a reposition was the standing correction — not a count of repositions',
    },
    {
      label: 'mid-sequence repositions',
      tb: timebase.midInputSeeks,
      sw: syncwave.midInputSeeks,
      format: String,
      note: 'a jump while the operator was typing costs them their place',
    },
    { label: 'invisible nudges', tb: timebase.nudges, sw: syncwave.nudges, format: String, better: 'higher' },
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Metric (ms unless stated)</th>
            <th className="ok">Timebase</th>
            <th className="bad">Command mirroring</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const format = row.format ?? ((v: number) => v.toFixed(1))
            const better = row.better ?? 'lower'
            const tbWins = better === 'lower' ? row.tb < row.sw : row.tb > row.sw
            const tie = row.tb === row.sw
            return (
              <tr key={row.label}>
                <td className="muted">
                  {row.label}
                  {row.note ? (
                    <div style={{ fontSize: 10, opacity: 0.75, whiteSpace: 'normal', maxWidth: 260 }}>
                      {row.note}
                    </div>
                  ) : null}
                </td>
                <td className={!tie && tbWins ? 'ok' : ''}>{format(row.tb)}</td>
                <td className={!tie && !tbWins ? 'bad' : ''}>{format(row.sw)}</td>
              </tr>
            )
          })}
          <tr>
            <td className="muted">channel</td>
            <td colSpan={2} className="muted">
              {timebase.delivered} delivered · {timebase.dropped} dropped — identical for both
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

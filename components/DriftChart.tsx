import { FRAME_TOLERANCE_S, QC_DRIFT_MS } from '@/lib/protocol'
import type { SamplePoint } from '@/lib/metrics'

const WIDTH = 520
const HEIGHT = 130

/**
 * Both series on one pair of axes, sharing a scale. A log-ish clamp keeps a
 * ten-second excursion from flattening a forty-millisecond one into the axis.
 */
export function DriftChart({
  timebase,
  syncwave,
}: {
  timebase: readonly SamplePoint[]
  syncwave: readonly SamplePoint[]
}) {
  const all = [...timebase, ...syncwave]
  if (all.length < 2) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Collecting samples. Press play on the lead.
      </p>
    )
  }

  const peak = Math.max(200, ...all.map((point) => Math.abs(point.errorMs)))
  const scale = (errorMs: number) => HEIGHT / 2 - (errorMs / peak) * (HEIGHT / 2 - 6)

  const path = (series: readonly SamplePoint[]) => {
    if (series.length < 2) return ''
    const step = WIDTH / Math.max(1, series.length - 1)
    return series
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)},${scale(point.errorMs).toFixed(1)}`)
      .join(' ')
  }

  const band = (ms: number) => ({
    y: scale(ms),
    height: Math.max(1, scale(-ms) - scale(ms)),
  })
  const frame = band(FRAME_TOLERANCE_S * 1000)
  const qc = band(QC_DRIFT_MS)

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Error against program-date-time over time, timebase versus command mirroring"
      >
        <rect x={0} y={qc.y} width={WIDTH} height={qc.height} fill="#ffb020" opacity={0.07} />
        <rect x={0} y={frame.y} width={WIDTH} height={frame.height} fill="#3ddc91" opacity={0.14} />
        <line x1={0} y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} stroke="#3a424e" strokeWidth={1} />
        <path d={path(syncwave)} fill="none" stroke="#ff5c5c" strokeWidth={1.5} />
        <path d={path(timebase)} fill="none" stroke="#3ddc91" strokeWidth={1.5} />
      </svg>
      <div className="row muted" style={{ fontSize: 11, gap: 14, marginTop: 4 }}>
        <span className="ok">— timebase</span>
        <span className="bad">— command mirroring</span>
        <span>green band = one frame · amber = QC threshold · scale ±{(peak / 1000).toFixed(1)} s</span>
      </div>
    </div>
  )
}

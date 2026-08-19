'use client'

import { IMPAIRMENT_PRESETS } from '@/lib/impair'
import type { ImpairmentConfig } from '@/lib/protocol'
import type { SyncwaveDefectFlags } from '@/lib/syncwave'

const PRESET_LABELS: { key: keyof typeof IMPAIRMENT_PRESETS; label: string; detail: string }[] = [
  { key: 'clean', label: 'Clean', detail: 'no loss, no delay' },
  { key: 'wifi', label: 'Wi-Fi', detail: '1% loss · 25 ± 10 ms' },
  { key: 'lossyWan', label: 'Lossy WAN', detail: '8% loss · 120 ± 45 ms' },
  { key: 'awful', label: 'Awful', detail: '25% loss · 400 ± 150 ms' },
]

const DEFECT_LABELS: { key: keyof SyncwaveDefectFlags; label: string; consequence: string }[] = [
  {
    key: 'ignoreAt',
    label: 'Ignores the message timestamp',
    consequence: 'the follower sits one one-way delay behind, permanently and invisibly',
  },
  {
    key: 'rateBug',
    label: 'Rate change without projecting first',
    consequence: 'the playhead jumps backward by however long the old rate had been running',
  },
  {
    key: 'tolerantSeek',
    label: 'Discards a seek inside tolerance',
    consequence: 'a small deliberate seek by the lead is silently lost',
  },
  {
    key: 'noSequence',
    label: 'No ordering check',
    consequence: 'a reordered delivery is applied and then undone — a visible stutter',
  },
]

/**
 * The impairment is seeded, so both followers get identical drops and delays. The
 * defect toggles exist so the obvious objection — "it only wins because the other one
 * has bugs" — can be tested rather than argued about. Turn all four off; the gap that
 * remains is the structural one.
 */
export function ImpairmentPanel({
  config,
  onConfig,
  defects,
  onDefects,
  onDropNext,
  stats,
}: {
  config: ImpairmentConfig
  onConfig: (config: ImpairmentConfig) => void
  defects: SyncwaveDefectFlags
  onDefects: (defects: SyncwaveDefectFlags) => void
  onDropNext: (count: number) => void
  stats: { delivered: number; dropped: number; inFlight: number }
}) {
  const activePreset = PRESET_LABELS.find(
    (preset) =>
      IMPAIRMENT_PRESETS[preset.key]!.dropRate === config.dropRate &&
      IMPAIRMENT_PRESETS[preset.key]!.baseLatencyMs === config.baseLatencyMs,
  )?.key

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div>
        <div className="row">
          {PRESET_LABELS.map((preset) => (
            <button
              key={preset.key}
              onClick={() => onConfig({ ...IMPAIRMENT_PRESETS[preset.key]!, outage: config.outage })}
              className={activePreset === preset.key ? 'primary' : ''}
              title={preset.detail}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
          {PRESET_LABELS.find((p) => p.key === activePreset)?.detail ?? 'custom'} · seeded on the
          message sequence, so both followers lose the same messages
        </p>
      </div>

      <div className="row">
        <button onClick={() => onDropNext(1)}>Drop next message</button>
        <button onClick={() => onDropNext(5)}>Drop next 5</button>
        <button onClick={() => onConfig({ ...config, outage: !config.outage })}>
          {config.outage ? 'End outage' : 'Total outage'}
        </button>
        <span className="muted mono" style={{ fontSize: 11 }}>
          {stats.delivered} delivered · {stats.dropped} dropped · {stats.inFlight} in flight
        </span>
      </div>

      <div>
        <h2 style={{ marginBottom: 6 }}>Command-mirroring defects</h2>
        <div className="grid" style={{ gap: 4 }}>
          {DEFECT_LABELS.map((defect) => (
            <label key={defect.key} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={defects[defect.key]}
                onChange={(event) =>
                  onDefects({ ...defects, [defect.key]: event.target.checked })
                }
                style={{ marginTop: 4 }}
              />
              <span style={{ fontSize: 12 }}>
                {defect.label}
                <span className="muted"> — {defect.consequence}</span>
              </span>
            </label>
          ))}
        </div>
        {!Object.values(defects).some(Boolean) ? (
          <p className="info" style={{ fontSize: 12, marginBottom: 0 }}>
            All four off. What remains is the part that is not a bug: a mirrored command
            carries the lead&apos;s playhead, and on a live stream that is not a coordinate the
            follower shares.
          </p>
        ) : null}
      </div>
    </div>
  )
}

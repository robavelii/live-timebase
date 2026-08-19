import type { ClockDiagnostics } from '@/hooks/useClockSync'
import type { FollowerDiagnostics } from '@/hooks/useFollower'
import type { MediaInfo } from '@/hooks/useMediaSource'
import { CorrectionKind } from '@/lib/timebase'
import type { Transport } from '@/lib/protocol'

const ms = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(0)} ms`

const driftClass = (kind: FollowerDiagnostics['kind'], driftMs: number) => {
  if (kind === CorrectionKind.HOLD || kind === CorrectionKind.WAIT) return 'muted'
  const magnitude = Math.abs(driftMs)
  if (magnitude < 40) return 'ok'
  if (magnitude < 250) return 'warn'
  return 'bad'
}

const CORRECTION_LABEL: Record<string, string> = {
  none: 'locked',
  nudge: 'nudge',
  seek: 'reposition',
  hold: 'hold — clock',
  wait: 'wait',
}

const WAIT_LABEL: Record<string, string> = {
  'no-transport': 'no transport yet',
  'no-pdt-mapping': 'no program-date-time mapping',
  'outside-dvr': 'target outside DVR window',
  'no-media': 'nothing decoded yet',
  seeking: 'seek in flight',
  unlocked: 'working independently',
  hidden: 'window not being drawn',
}

export function Diagnostics({
  clock,
  follower,
  media,
  transport,
}: {
  clock: ClockDiagnostics
  follower: FollowerDiagnostics
  media: MediaInfo
  transport: Transport | null
}) {
  const pdt = media.pdt
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="stats">
        <div className="stat">
          <div className="label">Drift vs session</div>
          <div className={`value ${driftClass(follower.kind, follower.driftMs)}`}>
            {follower.kind === CorrectionKind.HOLD || follower.kind === CorrectionKind.WAIT
              ? '—'
              : ms(follower.driftMs)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Correction</div>
          <div className="value">
            {CORRECTION_LABEL[follower.kind] ?? follower.kind}
            {follower.appliedRate ? (
              <span className="muted"> {follower.appliedRate.toFixed(3)}×</span>
            ) : null}
          </div>
          {follower.waitReason ? (
            <div className="muted" style={{ fontSize: 11 }}>
              {WAIT_LABEL[follower.waitReason]}
            </div>
          ) : null}
        </div>
        <div className="stat">
          <div className="label">Frame-accurate</div>
          <div className="value">{follower.frameAccuratePct.toFixed(1)}%</div>
          <div className="muted" style={{ fontSize: 11 }}>
            p95 {follower.p95DriftMs.toFixed(0)} ms · n={follower.samples}
          </div>
        </div>
        <div className="stat">
          <div className="label">Repositions</div>
          <div className="value">{follower.seeks}</div>
          <div className="muted" style={{ fontSize: 11 }}>{follower.nudges} nudges</div>
        </div>
        <div className="stat">
          <div className="label">Clock offset</div>
          <div className={`value ${clock.trusted ? '' : 'warn'}`}>
            {clock.trusted ? ms(clock.offsetMs) : 'untrusted'}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            rtt {clock.minRttMs.toFixed(1)} ms · ±{clock.worstCaseErrorMs.toFixed(1)} ms
          </div>
        </div>
        <div className="stat">
          <div className="label">Clock steps</div>
          <div className={`value ${clock.stepsDetected ? 'warn' : ''}`}>
            {clock.stepsDetected}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>{clock.samples} samples</div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Playlist</div>
          <div className="value">{media.live ? 'live' : 'vod'}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {media.engine} · target {media.targetDuration || '—'}s
          </div>
        </div>
        <div className="stat">
          <div className="label">Program-date-time</div>
          <div className={`value ${pdt.present ? 'ok' : media.live ? 'bad' : 'muted'}`}>
            {pdt.present ? 'present' : media.live ? 'missing' : 'n/a'}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {pdt.anchors} fragments mapped · cc {pdt.cc ?? '—'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Continuity</div>
          <div className={`value ${pdt.pdtBreaks ? 'bad' : pdt.discontinuities ? 'warn' : 'ok'}`}>
            {pdt.discontinuities} / {pdt.pdtBreaks}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>discontinuities / pdt breaks</div>
        </div>
        <div className="stat">
          <div className="label">Frame callbacks</div>
          <div className={`value ${media.frameCallbacks ? 'ok' : 'bad'}`}>
            {media.frameCallbacks ? 'rVFC' : 'missing'}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>{media.staleReads} stale reads</div>
        </div>
        <div className="stat">
          <div className="label">Mapping</div>
          <div className="value">{follower.mapping ?? '—'}</div>
          <div className="muted" style={{ fontSize: 11 }}>shared → local</div>
        </div>
        <div className="stat">
          <div className="label">Transport</div>
          <div className="value" style={{ fontSize: 13 }}>
            {transport ? `${transport.state} ${transport.rate}×` : '—'}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {transport ? `e${transport.epoch % 100000}·s${transport.sequence} ${transport.reason}` : ''}
          </div>
        </div>
      </div>
    </div>
  )
}

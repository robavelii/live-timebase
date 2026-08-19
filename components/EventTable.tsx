import type { AckInfo } from '@/hooks/useOutbox'
import type { CollectedEvent } from '@/lib/protocol'

const absolute = (pdt: number | null) =>
  pdt === null ? '—' : new Date(pdt).toISOString().slice(11, 23)

const SOURCE_FLAG: Record<string, string> = {
  rvfc: '',
  currentTime: '~',
  'currentTime-stale-frame': '⚠',
}

/**
 * The two columns that carry the argument are `pdt · 1st key` and `wire lag`. The
 * first is the event's time on live and does not move however bad the link gets;
 * the second is what people are afraid of. Showing them side by side is the point.
 */
export function EventTable({
  events,
  acks,
}: {
  events: CollectedEvent[]
  acks: Record<string, AckInfo>
}) {
  if (events.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        No events yet. Type a shirt number, an action letter, a grade, then a keypad zone.
      </p>
    )
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>seq</th>
            <th>keys</th>
            <th>pdt · 1st key</th>
            <th>media t</th>
            <th>src</th>
            <th>Δ commit</th>
            <th>wire lag</th>
            <th>ack</th>
          </tr>
        </thead>
        <tbody>
          {[...events].reverse().map((event) => {
            const ack = acks[event.clientEventId]
            const lagClass = !ack ? 'muted' : ack.wireLagMs > 1_000 ? 'warn' : ''
            return (
              <tr key={event.clientEventId}>
                <td className="muted">{event.deviceSequence}</td>
                <td>{event.sequenceKeys || '—'}</td>
                <td className={event.pdtSource === 'frag' ? 'ok' : event.pdtSource === 'extrapolated' ? 'warn' : 'bad'}>
                  {absolute(event.programDateTime)}
                  {event.pdtSource === 'extrapolated' ? ' ~' : ''}
                  {event.pdtSource === 'none' ? ' ✗' : ''}
                </td>
                <td className="muted">{event.mediaTime.toFixed(3)}</td>
                <td className={event.mediaTimeSource === 'rvfc' ? 'muted' : 'warn'}>
                  {SOURCE_FLAG[event.mediaTimeSource] ?? ''}
                  {event.mediaTimeSource === 'rvfc' ? 'rvfc' : event.mediaTimeSource === 'currentTime' ? 'ct' : 'stale'}
                </td>
                <td className="muted">{event.inputDurationMs} ms</td>
                <td className={lagClass}>{ack ? `${ack.wireLagMs} ms` : 'queued'}</td>
                <td className={ack ? (ack.status === 'replayed' ? 'info' : 'ok') : 'muted'}>
                  {ack ? (ack.status === 'replayed' ? 'replay' : 'ok') : '…'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

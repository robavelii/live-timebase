import type { DuelPair } from '@/lib/protocol'

const absolute = (pdt: number | null, media: number) =>
  pdt === null ? media.toFixed(3) : new Date(pdt).toISOString().slice(14, 23)

/**
 * Pairing is the only place the two collectors' independent captures are ever
 * compared — and it works solely because both are coordinates on a timeline that
 * neither machine owns.
 *
 * Nothing here arbitrates. A separation of a couple of hundred milliseconds is two
 * people's reaction times on one contest, not a conflict to resolve; picking a
 * winner would destroy information that downstream analysis wants.
 */
export function DuelTable({ duels }: { duels: DuelPair[] }) {
  if (duels.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        No pairs yet. Tag one contest from both consoles within two seconds of each other.
      </p>
    )
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>pair</th>
            <th>home</th>
            <th>away</th>
            <th>Δ</th>
            <th>on</th>
          </tr>
        </thead>
        <tbody>
          {[...duels].reverse().map((duel) => (
            <tr key={duel.id}>
              <td className="info">{duel.id}</td>
              <td>
                {duel.home.sequenceKeys}{' '}
                <span className="muted">
                  {absolute(duel.home.programDateTime, duel.home.mediaTime)}
                </span>
              </td>
              <td>
                {duel.away.sequenceKeys}{' '}
                <span className="muted">
                  {absolute(duel.away.programDateTime, duel.away.mediaTime)}
                </span>
              </td>
              <td className={duel.deltaMs < 500 ? 'ok' : 'warn'}>{duel.deltaMs} ms</td>
              <td className="muted">{duel.coordinate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

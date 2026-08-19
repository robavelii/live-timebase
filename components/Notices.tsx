import type { SourceNotice } from '@/hooks/useMediaSource'

const clock = (at: number) => new Date(at).toISOString().slice(11, 19)

export function Notices({ notices }: { notices: SourceNotice[] }) {
  if (notices.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Nothing to report. Stream continuity is checked on every playlist refresh, not once at
        startup — presence of a program-date-time at load is necessary and not sufficient.
      </p>
    )
  }
  return (
    <ul className="notices">
      {[...notices].reverse().map((notice) => (
        <li key={`${notice.at}-${notice.text}`} className={notice.level === 'info' ? 'muted' : notice.level}>
          <span className="mono">{clock(notice.at)}</span> {notice.text}
        </li>
      ))}
    </ul>
  )
}

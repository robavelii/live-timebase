import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Live timebase — two collector consoles, one stream',
  description:
    'Two collectors on one live HLS URL, tagging events against a program-date-time timebase.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

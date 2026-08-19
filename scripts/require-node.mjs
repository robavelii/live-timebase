/**
 * The harness scripts need Node 22.6 or newer: `WebSocket` as a global for the CDP
 * client, and type stripping so the tests import `lib/*.ts` with no build step.
 *
 * Worth checking explicitly. On a machine with both a system Node and a version
 * manager, a non-interactive shell often gets the older one, and the failure that
 * produces — `crypto is not defined`, or a syntax error inside a `.ts` import — sends
 * you looking at the wrong thing entirely.
 */

export function requireNode(minimum = [22, 6]) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  const tooOld = major < minimum[0] || (major === minimum[0] && minor < minimum[1])
  if (!tooOld) return

  console.error(
    `\nThis script needs Node ${minimum.join('.')}+ and is running ${process.versions.node} (${process.execPath}).\n` +
      `\nIf you use nvm:  nvm use 24    (there is an .nvmrc here)\n`,
  )
  process.exit(78)
}

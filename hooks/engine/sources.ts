// The instruments: each kind of activity has a place on the spectrum, low to
// high, and a color. A tool plays the instrument of its kind, and a typed key
// plays where it sits on the keyboard.

export type SourceId = 'think' | 'text' | 'read' | 'edit' | 'bash' | 'web' | 'agent' | 'args'

export type Source = { id: SourceId; label: string; at: number; color: number }

/** Low to high: where each kind of activity sits on the spectrum. */
export const SOURCES: readonly Source[] = [
  { id: 'think', label: 'think', at: 0.05, color: 0x8b5cf6 },
  { id: 'text', label: 'text', at: 0.18, color: 0xd97757 },
  { id: 'read', label: 'read', at: 0.32, color: 0x38bdf8 },
  { id: 'edit', label: 'edit', at: 0.45, color: 0x22c55e },
  { id: 'bash', label: 'bash', at: 0.58, color: 0xfacc15 },
  { id: 'web', label: 'web/mcp', at: 0.71, color: 0xf472b6 },
  { id: 'agent', label: 'agents', at: 0.84, color: 0x2dd4bf },
  { id: 'args', label: 'args', at: 0.95, color: 0xe5e7eb },
]

export const N = SOURCES.length
export const INDEX = Object.fromEntries(SOURCES.map((s, i) => [s.id, i])) as Record<SourceId, number>

const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'LSP', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BASH = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'TaskStop', 'PowerShell'])
const WEB = new Set(['WebFetch', 'WebSearch'])

/** Which instrument a tool plays. */
export function sourceOf(tool: string): SourceId {
  if (READ.has(tool)) return 'read'
  if (EDIT.has(tool)) return 'edit'
  if (BASH.has(tool)) return 'bash'
  if (WEB.has(tool) || tool.startsWith('mcp__')) return 'web'
  return 'agent'
}

/** Where a key plays: where it sits on the keyboard, the left hand low and the right high; any other character, scattered. */
export function placeOf(ch: string): number {
  const c = ch.toLowerCase()
  for (const [keys, shift] of KEYBOARD) {
    const column = keys.indexOf(c)
    if (column >= 0) return 0.06 + (0.88 * (column + shift)) / 9.5
  }
  return 0.06 + 0.88 * (((c.codePointAt(0) ?? 0) * 0.618034) % 1)
}

/** A tool's name as drawn: an MCP tool without its server, printable, short. */
export function shortName(tool: string): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 18)
}

/** The keyboard, row by row, with how far each row sits to the right, as a key's place on the spectrum. */
const KEYBOARD: readonly (readonly [string, number])[] = [
  ['1234567890', 0],
  ['qwertyuiop', 0.5],
  ['asdfghjkl', 0.75],
  ['zxcvbnm', 1.25],
]

/** Human-readable one-liner for a tool call, for the chat action trace. */
export function describeAction(name: string, args: Record<string, unknown>): string {
  if (name === 'navigate') return `🌐 navigate ${String(args.url ?? '')}`
  if (name === 'go_back') return '⬅️ go back'

  const action = String(args.action ?? 'unknown')
  const coord = Array.isArray(args.coordinate) ? ` (${args.coordinate[0]}, ${args.coordinate[1]})` : ''
  switch (action) {
    case 'screenshot':
      return '📸 screenshot'
    case 'left_click':
      return `🖱 left_click${coord}`
    case 'double_click':
      return `🖱 double_click${coord}`
    case 'right_click':
      return `🖱 right_click${coord}`
    case 'middle_click':
      return `🖱 middle_click${coord}`
    case 'mouse_move':
      return `🖱 mouse_move${coord}`
    case 'left_click_drag':
      return `🖱 drag${coord}`
    case 'type':
      return `⌨️ type ${JSON.stringify(String(args.text ?? '')).slice(0, 60)}`
    case 'key':
      return `⌨️ key ${String(args.text ?? '')}`
    case 'scroll':
      return `🖱 scroll ${String(args.scroll_direction ?? 'down')}`
    case 'wait':
      return '⏳ wait'
    case 'cursor_position':
      return '🖱 cursor_position'
    default:
      return action
  }
}

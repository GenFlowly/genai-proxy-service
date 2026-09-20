/**
 * Node-side "computer" surface backed by a real Playwright Chromium page.
 *
 * Playwright runs in Node (not the browser tab), so the Vite dev server owns a
 * single Chromium page and exposes it over /computer/* endpoints. This module
 * is that page's controller: it maps Anthropic computer-use actions onto
 * Playwright calls, translates xdotool-style key names, and serializes every
 * page operation through a mutex so the live-view poll and the agent loop can't
 * interleave on the same page.
 *
 * Coordinates are 1:1 with the viewport (deviceScaleFactor 1), so Claude's
 * click coordinates land exactly, and page.screenshot() returns a
 * SCREEN_WIDTH x SCREEN_HEIGHT PNG matching the display_*_px on the tool.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/computer/constants'

export interface ActionOutcome {
  content: string
  /** Base64 PNG (no data: prefix) for screenshot actions */
  screenshotBase64?: string
}

export interface ViewState {
  screenshotBase64: string
  url: string
  title: string
}

const START_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Ready</title></head>
     <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:system-ui,sans-serif;background:#0f2540;color:#eaf2ff;text-align:center">
       <div><div style="font-size:44px">🌐</div>
       <h1 style="font-weight:600">Real browser ready</h1>
       <p style="opacity:.75;max-width:32rem">Ask Claude to open a website below — e.g.
       “Go to example.com” or “Open dol.wa.gov and start a tab renewal”.</p></div>
     </body></html>`
  )

/** xdotool / Anthropic key name → Playwright key name. */
const KEY_MAP: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  kp_enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  page_up: 'PageUp',
  page_down: 'PageDown',
  prior: 'PageUp',
  next: 'PageDown',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
}
const MOD_MAP: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  meta: 'Meta',
  win: 'Meta',
}

/** "ctrl+s" -> "Control+S", "Return" -> "Enter", "a" -> "a". */
function translateKey(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  return parts
    .map((part, i) => {
      const low = part.toLowerCase()
      if (i < parts.length - 1 && MOD_MAP[low]) return MOD_MAP[low]
      if (MOD_MAP[low] && parts.length > 1) return MOD_MAP[low]
      if (KEY_MAP[low]) return KEY_MAP[low]
      return part.length === 1 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('+')
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max - 1, Math.round(v)))
}

export class PlaywrightSurfaceServer {
  private browser: Browser | null = null
  private page: Page | null = null
  private launching: Promise<Page> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private cursor = { x: Math.round(SCREEN_WIDTH / 2), y: Math.round(SCREEN_HEIGHT / 2) }
  private readonly headed: boolean

  constructor(opts: { headed?: boolean } = {}) {
    this.headed = opts.headed ?? false
  }

  /** Single-flight browser+page launch. */
  private ensurePage(): Promise<Page> {
    if (this.page) return Promise.resolve(this.page)
    if (this.launching) return this.launching
    this.launching = (async () => {
      const browser = await chromium.launch({ headless: !this.headed })
      const context = await browser.newContext({
        viewport: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
        deviceScaleFactor: 1,
      })
      const page = await context.newPage()
      await page.goto(START_PAGE)
      this.browser = browser
      this.page = page
      return page
    })()
    return this.launching
  }

  /** Serialize all page operations so poll + agent loop never overlap. */
  private run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const page = await this.ensurePage()
      return fn(page)
    })
    // Keep the chain alive even if this task rejects
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async shot(page: Page): Promise<string> {
    const buf = await page.screenshot({ type: 'png' })
    return buf.toString('base64')
  }

  private async settle(page: Page): Promise<void> {
    // Best-effort: let a click-triggered navigation reach a usable state
    // without hanging on long-polling sites.
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined)
  }

  view(): Promise<ViewState> {
    return this.run(async (page) => ({
      screenshotBase64: await this.shot(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
    }))
  }

  navigate(rawUrl: string): Promise<ActionOutcome> {
    return this.run(async (page) => {
      let url = (rawUrl || '').trim()
      if (!url) return { content: 'no url provided' }
      if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith('data:') && !url.startsWith('about:')) {
        url = 'https://' + url
      }
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        return { content: `navigated to ${page.url()} — "${await page.title().catch(() => '')}"` }
      } catch (e) {
        return { content: `navigation to ${url} failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    })
  }

  goBack(): Promise<ActionOutcome> {
    return this.run(async (page) => {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined)
      return { content: `went back — now at ${page.url()}` }
    })
  }

  execute(args: Record<string, unknown>): Promise<ActionOutcome> {
    return this.run((page) => this.applyAction(page, args))
  }

  private async applyAction(page: Page, args: Record<string, unknown>): Promise<ActionOutcome> {
    const action = String(args.action ?? '')
    const coord = (): [number, number] => {
      const c = args.coordinate
      if (Array.isArray(c) && c.length >= 2) {
        this.cursor = { x: clamp(Number(c[0]), SCREEN_WIDTH), y: clamp(Number(c[1]), SCREEN_HEIGHT) }
      }
      return [this.cursor.x, this.cursor.y]
    }

    try {
      switch (action) {
        case 'screenshot':
          return { content: '', screenshotBase64: await this.shot(page) }

        case 'left_click': {
          const [x, y] = coord()
          await page.mouse.click(x, y)
          await this.settle(page)
          return { content: `clicked (${x}, ${y})` }
        }
        case 'double_click': {
          const [x, y] = coord()
          await page.mouse.dblclick(x, y)
          await this.settle(page)
          return { content: `double-clicked (${x}, ${y})` }
        }
        case 'right_click': {
          const [x, y] = coord()
          await page.mouse.click(x, y, { button: 'right' })
          return { content: `right-clicked (${x}, ${y})` }
        }
        case 'middle_click': {
          const [x, y] = coord()
          await page.mouse.click(x, y, { button: 'middle' })
          return { content: `middle-clicked (${x}, ${y})` }
        }
        case 'mouse_move': {
          const [x, y] = coord()
          await page.mouse.move(x, y)
          return { content: `moved to (${x}, ${y})` }
        }
        case 'left_click_drag': {
          const start = args.start_coordinate
          if (Array.isArray(start) && start.length >= 2) {
            await page.mouse.move(clamp(Number(start[0]), SCREEN_WIDTH), clamp(Number(start[1]), SCREEN_HEIGHT))
          }
          const [x, y] = coord()
          await page.mouse.down()
          await page.mouse.move(x, y, { steps: 8 })
          await page.mouse.up()
          return { content: `dragged to (${x}, ${y})` }
        }
        case 'type': {
          const text = String(args.text ?? '')
          await page.keyboard.type(text)
          return { content: `typed ${JSON.stringify(text).slice(0, 60)}` }
        }
        case 'key': {
          const combo = translateKey(String(args.text ?? ''))
          await page.keyboard.press(combo)
          await this.settle(page)
          return { content: `pressed ${combo}` }
        }
        case 'scroll': {
          const [x, y] = coord()
          await page.mouse.move(x, y)
          const amount = Number(args.scroll_amount ?? 3)
          const dir = String(args.scroll_direction ?? 'down')
          const step = amount * 120 // wheel notches → pixels
          const dx = dir === 'left' ? -step : dir === 'right' ? step : 0
          const dy = dir === 'up' ? -step : dir === 'down' ? step : 0
          await page.mouse.wheel(dx, dy)
          return { content: `scrolled ${dir}` }
        }
        case 'wait': {
          const secs = Math.min(5, Number(args.duration ?? 1))
          await page.waitForTimeout(secs * 1000)
          return { content: `waited ${secs}s` }
        }
        case 'cursor_position':
          return { content: `(${this.cursor.x}, ${this.cursor.y})` }

        default:
          return { content: `unsupported action: ${action}` }
      }
    } catch (e) {
      return { content: `action "${action}" failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close()
    } catch {
      // ignore
    }
    this.browser = null
    this.page = null
    this.launching = null
  }
}

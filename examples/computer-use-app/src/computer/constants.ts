/**
 * The Playwright viewport size, shared by the Node surface server (browser
 * viewport + screenshot size) and the client (the display_*_px declared on the
 * computer tool). These MUST match so Claude's click coordinates map 1:1 onto
 * the page. 1280x800 is a roomy, widely-tested computer-use display size.
 */
export const SCREEN_WIDTH = 1280
export const SCREEN_HEIGHT = 800

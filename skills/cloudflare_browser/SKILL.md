---
name: cloudflare_browser
description: Control headless Chrome via Cloudflare Browser Rendering CDP WebSocket. Use for screenshots, page navigation, scraping, and video capture when browser automation is needed in a Cloudflare Workers environment. Requires CDP_SECRET env var and cdpUrl configured in browser.profiles.
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
user-invocable: true
---

# Cloudflare Browser Rendering

Control headless browsers via Cloudflare's Browser Rendering service using CDP (Chrome DevTools Protocol) over WebSocket.

## Usage

- `/cloudflare_browser screenshot <url> [output.png]` — Take a screenshot
- `/cloudflare_browser video <url1,url2,...> [output.mp4]` — Capture video of multiple URLs
- `/cloudflare_browser` — Show usage

## Prerequisites

- `CDP_SECRET` environment variable set
- Browser profile configured in openclaw.json with `cdpUrl`

## CDP Connection Pattern

The worker creates a page target automatically on WebSocket connect. Listen for `Target.targetCreated` event to get the `targetId`.

## Key CDP Commands

| Command | Purpose |
|---------|---------|
| Page.navigate | Navigate to URL |
| Page.captureScreenshot | Capture PNG/JPEG |
| Runtime.evaluate | Execute JavaScript |
| Emulation.setDeviceMetricsOverride | Set viewport size |

## Troubleshooting

- **No target created**: Wait for `Target.targetCreated` event with timeout
- **Commands timeout**: Worker cold start delay; increase timeout to 30-60s
- **WebSocket hangs**: Verify `CDP_SECRET` matches worker configuration

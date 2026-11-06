# Strata — Context-Aware Note-Taking, Decisions & Tasks PWA

Strata is a **zero-install, local-first Progressive Web App** designed for restricted corporate laptops:
- **Zero backend / zero external note storage:** Runs 100% client-side in Chrome or Microsoft Edge.
- **Instant startup (<50ms):** IndexedDB cache opens straight into an Instant Note Canvas (`Alt+N`).
- **Two-way OneDrive / Local Folder Sync:** Uses the Chromium File System Access API (`showDirectoryPicker`) to sync plain Markdown (`.md`) files with YAML frontmatter into `Inbox/`, `Internal/<Project>/`, and `Clients/<Client>/<Project>/`.
- **Pluggable AI + Offline Fallback:** Works offline out of the box via the Local Smart Engine, and optionally connects to corporate Azure OpenAI, OpenAI-compatible gateways, Gemini, or Anthropic (API keys stay exclusively in browser `localStorage`, never written to synced files).

## Using on Your Corporate Device (GitHub Pages + Edge/Chrome PWA)

1. Push this repository to GitHub (the included [deploy-pages.yml](.github/workflows/deploy-pages.yml) workflow automatically builds and deploys `./dist` to GitHub Pages).
2. In GitHub repository **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Open your `https://<username>.github.io/<repo>/` URL in Edge or Chrome on your corporate laptop:
   - Click the **Install App** icon in the address bar (`⋯` → **Apps** → **Install this site as an app**) for a dedicated taskbar/dock app window.
   - Click **Folder** in the bottom-left sidebar and select an empty folder inside your corporate **OneDrive** (e.g., `OneDrive/Strata-Notes`) for automatic two-way `.md` sync and backup.

## Local Development

```bash
npm install
npm run dev
```

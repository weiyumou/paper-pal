# Paper Pal

A lightweight PDF reader for academic researchers, built on Electron and PDF.js. You can see what a cited paper is about without leaving the one you're reading.

## Features

- **Citation lookup.** Click an in-text citation and the right panel shows the cited paper instead of jumping to the reference list. It shows the title, authors, venue, abstract, DOI and arXiv links. Metadata comes from Crossref, Semantic Scholar and OpenAlex, and needs no API key.
- **AI summaries (optional).** With an OpenRouter key, each cited paper gets a short summary of its abstract, using any model on OpenRouter. Without a key, Paper Pal shows the Semantic Scholar TLDR when one exists.
- **Highlights and notes.** Mark text in six colours, attach a note to a highlight, and keep a note for the whole paper. Everything saves automatically. Notes are tied to the PDF's contents, so they survive renaming or moving the file. You can export them as Markdown (⌘E).
- **Marker tool.** Switch between the select and marker tools with V and M, or with the mouse's side buttons by default. Both shortcuts can be changed in Settings.
- **Search and translate.** Search selected text on Google or Google Scholar in the side panel. Translate passages with an OpenRouter key; by default it switches between English and Chinese.
- **Reading comforts.** Find (⌘F), pinch or ⌘-scroll zoom, fit to width, Open Recent, and reopening the last document where you left off.

## Requirements

- macOS on Apple silicon (the packaging scripts target `darwin`/`arm64`)
- Node.js and npm

## Run from source

```bash
npm install
```

```bash
npm start
```

## Build and install

```bash
npm run package
```

This builds `dist/Paper Pal-darwin-arm64/Paper Pal.app`. To build, ad-hoc sign and copy it to `/Applications` in one step:

```bash
npm run install-app
```

## Data and keys

Annotations and settings are stored in `~/Library/Application Support/paper-pal/`. The source build and the packaged app share this folder. API keys are encrypted with the system keychain through Electron's `safeStorage`. Both keys are optional:

- **OpenRouter:** enables AI summaries and translation.
- **Semantic Scholar:** avoids rate limits on the shared keyless pool.

## License

[MIT](LICENSE) © 2026 Yumou Wei. The bundled [PDF.js](https://github.com/mozilla/pdf.js) is licensed under Apache-2.0.

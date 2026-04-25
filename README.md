# 🛡️ ClauseGuard

AI-powered contract analysis that explains every clause in plain English before you sign.

**[Live Demo →](https://clauseguard-seven.vercel.app)**

![ClauseGuard Screenshot](screenshot.png)

---

## Features

- **Drag-and-drop PDF upload** — paste a lease or employment contract and get results in seconds
- **Color-coded risk flags** — green (standard), amber (watch this), red (risky/unusual)
- **Plain-English explanations** — no legal jargon, written for the person signing
- **Negotiation tips** — actionable advice on every amber and red clause
- **Jurisdiction-aware analysis** — tailored for Ontario, BC, California, and New York law
- **Sample contract** — try it instantly without uploading anything
- **Prompt caching** — fast, cost-efficient Claude API calls on repeated analyses

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 App Router |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| AI | Anthropic Claude API (`claude-sonnet-4-6`) |
| PDF parsing | pdf-parse v2 |
| Deployment | Vercel |

## Local Setup

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/Kashh99/clauseguard.git
cd clauseguard

# 2. Install dependencies
npm install

# 3. Add your API key (see Environment Variables below)

# 4. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Create a `.env.local` file in the project root:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Never commit this file. It is already listed in `.gitignore`.

## Deploy

The easiest path is one-click deploy to Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Kashh99/clauseguard)

Add `ANTHROPIC_API_KEY` as an environment variable in the Vercel project settings before deploying.

## Disclaimer

ClauseGuard is for informational purposes only. It is not a substitute for advice from a qualified lawyer.

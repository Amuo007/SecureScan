# SecureScan 🛡️

**AI-powered cybersecurity risk analysis for GitHub repositories.** SecureScan scans your codebase for vulnerabilities, maps findings to the NIST Cybersecurity Framework, and generates actionable reports — all through a clean web UI.

Built for HackMISSO 2026.

---

## What It Does

SecureScan performs a deep security audit of any GitHub repo you own:

1. **Code Scan** — AI analyzes your most security-relevant files for confirmed and suspected vulnerabilities (SQLi, hardcoded secrets, missing auth, XSS, exposed data, and more)
2. **Commit History Scan** — Checks recent git history for accidentally committed secrets or credentials
3. **Security Questionnaire** — 10 plain-language questions (2 per NIST category) to capture context the code scan can't see
4. **NIST Report** — Findings mapped across all 5 NIST CSF functions: Identify, Protect, Detect, Respond, Recover — with letter grades, risk score, and prioritized recommendations
5. **AI Chat** — Ask follow-up questions about any finding with full repo context

---

## Diagrams

### Agent Flow
![Agent Flow](https://raw.githubusercontent.com/Amuo007/SecureScan/main/Agentflow.png)

### System Architecture
![Architecture](https://raw.githubusercontent.com/Amuo007/SecureScan/main/Architecture.png)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express 5 |
| AI | Anthropic Claude (claude-sonnet-4) |
| GitHub Integration | GitHub OAuth + REST API |
| Database | sql.js (SQLite in-process) |
| Frontend | Vanilla JS, Bootstrap 5, IBM Plex fonts |
| Session | express-session |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A GitHub OAuth App ([create one here](https://github.com/settings/developers))
- An Anthropic API key ([get one here](https://console.anthropic.com))

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/securescan.git
cd securescan
npm install
```

### Environment Setup

Create a `.env` file in the root directory:

```env
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
ANTHROPIC_API_KEY=your_anthropic_api_key
SESSION_SECRET=any_random_string_here
PORT=3000
```

For the GitHub OAuth App, set the callback URL to:
```
http://localhost:3000/auth/callback
```

### Run

```bash
node index.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How It Works

### Scan Flow

```
Login with GitHub
      ↓
Select a repository
      ↓
AI selects up to 15 security-relevant files
      ↓
Each file analyzed for vulnerabilities (confirmed + suspected)
      ↓
Commit history scanned for leaked secrets
      ↓
10-question security questionnaire
      ↓
5 deep-dive NIST category analyses
      ↓
Final report with score, grades, and recommendations
```

### Scoring

- Each vulnerability is weighted by severity: CRITICAL (20pts), HIGH (10pts), MEDIUM (5pts), LOW (2pts)
- Questionnaire answers add penalty points for bad answers
- Score is capped at 100 per NIST category; overall score is the average

| Score | Risk Level |
|---|---|
| 0–25 | LOW |
| 26–50 | MEDIUM |
| 51–75 | HIGH |
| 76–100 | CRITICAL |

### Caching

Scans are cached by commit SHA. If nothing has changed since the last scan, results are returned instantly. Incremental rescans only re-analyze changed files.

---

## Project Structure

```
securescan/
├── server.js           # Express routes and API
├── src/
│   ├── scanner.js      # Scan orchestration + score calculation
│   ├── claude.js       # All Anthropic API calls
│   ├── github.js       # GitHub API integration
│   └── db.js           # sql.js database layer
├── prompts/            # Markdown prompt templates for Claude
│   ├── analyze_file.md
│   ├── nist_identify.md
│   ├── nist_protect.md
│   ├── nist_detect.md
│   ├── nist_respond.md
│   ├── nist_recover.md
│   ├── generate_questions.md
│   ├── final_report.md
│   └── ...
├── public/             # Frontend (HTML, CSS, JS)
│   ├── login.html
│   ├── Repos.html
│   ├── Dashboard.html
│   ├── questions.html
│   ├── css/
│   └── js/
└── data/               # SQLite database (auto-created)
```

---

## Security Notes

- SecureScan requests **read-only** GitHub OAuth scope (`repo read:user`) — it never modifies your code
- GitHub tokens are stored server-side in session memory only
- The `data/` directory (SQLite DB) is local and never transmitted
- Add `data/` to your `.gitignore` before pushing

---

## License

ISC

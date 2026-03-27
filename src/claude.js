const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

// ─── Base Claude call ─────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
  const res = await axios.post(
    CLAUDE_API,
    {
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  return res.data.content[0].text;
}

// ─── Call 1: Decide which files to analyze ────────────────────
async function selectFilesToAnalyze(fileTree) {
  const system = `You are a cybersecurity expert. Your job is to look at a list of file paths in a repository and decide which ones are most relevant for a security analysis.

Focus on files that could contain:
- Secrets, API keys, passwords, tokens
- Authentication and authorization logic
- Configuration and environment settings
- Dependencies and package files
- CI/CD pipeline files
- Database connection strings
- Network or server configuration

Return ONLY a JSON array of file paths to analyze. No explanation. No markdown. Just the raw JSON array.
Example: ["config.js", ".env.example", "src/auth.js"]

Skip: test files, documentation, images, fonts, build artifacts, lock files (except package.json/requirements.txt).
Select a maximum of 15 files.`;

  const userMessage = `Here is the file tree for this repository:\n\n${fileTree.join('\n')}\n\nWhich files should I analyze for security issues?`;

  const response = await callClaude(system, userMessage, 500);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // fallback — pick common security-relevant files manually
    return fileTree.filter(f =>
      /\.(env|config|json|yaml|yml|js|ts|py|rb|php|sh)$/i.test(f) ||
      /(auth|secret|key|password|token|config|login|security)/i.test(f)
    ).slice(0, 15);
  }
}

// ─── Call 2: Analyze a single file ───────────────────────────
async function analyzeFile(filePath, fileContent) {
  const system = `You are a cybersecurity expert doing a code security review. Analyze the given file for security vulnerabilities.

For each issue found, identify:
- What the problem is (in plain English, no jargon)
- Severity: CRITICAL, HIGH, MEDIUM, or LOW
- Which NIST category it belongs to: identify, protect, detect, respond, or recover

Return ONLY a JSON object. No markdown. No explanation. Raw JSON only.

Format:
{
  "file": "filename",
  "summary": "one sentence about what this file does",
  "issues": [
    {
      "title": "short title of issue",
      "description": "plain English explanation of the problem and why it matters",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "nist_category": "identify|protect|detect|respond|recover",
      "fix": "specific actionable fix in 1-2 sentences"
    }
  ],
  "safe_practices": ["list of things this file does correctly security-wise"]
}

If no issues found, return empty issues array.`;

  const userMessage = `File: ${filePath}\n\nContent:\n${fileContent}`;

  const response = await callClaude(system, userMessage, 1000);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      file: filePath,
      summary: 'Could not parse analysis',
      issues: [],
      safe_practices: [],
    };
  }
}

// ─── Call 3: Analyze commit history findings ─────────────────
async function analyzeCommitHistory(commitFindings) {
  if (commitFindings.suspicious_commits.length === 0) {
    return {
      file: 'git_history',
      summary: 'No suspicious patterns found in recent commit history',
      issues: [],
      safe_practices: ['No secrets detected in recent commit history'],
    };
  }

  const system = `You are a cybersecurity expert. Analyze these suspicious patterns found in a git repository's commit history.

These patterns suggest secrets or credentials may have been committed to the repository at some point — even if later deleted, they are still in git history and potentially compromised.

Return ONLY a JSON object. No markdown. Raw JSON only.

Format:
{
  "file": "git_history",
  "summary": "one sentence summary of findings",
  "issues": [
    {
      "title": "short title",
      "description": "plain English explanation",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "nist_category": "identify|protect|detect|respond|recover",
      "fix": "specific fix"
    }
  ],
  "safe_practices": []
}`;

  const userMessage = `Git history analysis findings:\n\n${JSON.stringify(commitFindings, null, 2)}`;

  const response = await callClaude(system, userMessage, 800);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      file: 'git_history',
      summary: 'Suspicious patterns found in commit history',
      issues: commitFindings.suspicious_commits.map(f => ({
        title: `Potential secret in commit ${f.sha}`,
        description: `A pattern matching secret credentials was found in ${f.file}`,
        severity: 'HIGH',
        nist_category: 'protect',
        fix: 'Rotate any credentials that were ever committed. Use git-filter-repo to clean history.',
      })),
      safe_practices: [],
    };
  }
}

// ─── Call 4: Generate master report from all summaries ────────
async function generateMasterReport(repoName, fileSummaries) {
  const system = `You are a cybersecurity expert generating a final risk assessment report.

You will receive summaries of security analyses from multiple files in a repository.
Generate a comprehensive risk report.

Return ONLY a JSON object. No markdown. Raw JSON only.

Format:
{
  "overall_score": <number 0-100, where 100 is perfectly secure, 0 is critically vulnerable>,
  "risk_level": "CRITICAL|HIGH|MEDIUM|LOW",
  "nist_scores": {
    "identify": "<letter grade A-F>",
    "protect": "<letter grade A-F>",
    "detect": "<letter grade A-F>",
    "respond": "<letter grade A-F>",
    "recover": "<letter grade A-F>"
  },
  "vulnerabilities": [
    {
      "title": "short title",
      "description": "plain English, no jargon",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "nist_category": "identify|protect|detect|respond|recover",
      "file": "filename where found",
      "fix": "specific actionable fix"
    }
  ],
  "recommendations": [
    {
      "priority": 1,
      "action": "what to do",
      "reason": "why this matters in plain English",
      "nist_category": "category"
    }
  ],
  "summary": "2-3 sentence plain English overview of the security posture of this repo"
}

Sort vulnerabilities by severity (CRITICAL first).
Include top 4 recommendations only, sorted by priority.
Be specific — reference actual file names and issues found.`;

  const summariesText = fileSummaries
    .map(s => `FILE: ${s.file}\nSUMMARY: ${s.summary}\nISSUES: ${JSON.stringify(s.issues)}\n`)
    .join('\n---\n');

  const userMessage = `Repository: ${repoName}\n\nFile analysis summaries:\n\n${summariesText}`;

  const response = await callClaude(system, userMessage, 2000);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

module.exports = {
  selectFilesToAnalyze,
  analyzeFile,
  analyzeCommitHistory,
  generateMasterReport,
};
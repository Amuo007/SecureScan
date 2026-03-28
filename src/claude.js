const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// ─── Load prompt from .md file ────────────────────────────────
function loadPrompt(name) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  return fs.readFileSync(filePath, 'utf-8').trim();
}

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
  const system = loadPrompt('select_files');

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

  const system = loadPrompt('commit_history');

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

// ─── Call 5: Generate custom questions based on scan findings ─
async function generateQuestions(repoName, fileSummaries) {
  const system = loadPrompt('generate_questions');

  const summariesText = fileSummaries
    .map(s => `FILE: ${s.file} — ${s.summary}`)
    .join('\n');

  const userMessage = `Repository: ${repoName}\n\nWhat this repo contains:\n${summariesText}\n\nGenerate 6 security questions specific to this type of application.`;

  const response = await callClaude(system, userMessage, 1000);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // fallback generic questions
    return [
      { id: 1, question: "Do team members share login credentials for this project?", nist_category: "protect", type: "yesno", options: ["Yes", "No"], risk_if_no: "Shared credentials make it impossible to track who did what." },
      { id: 2, question: "Do you use two-factor authentication on accounts related to this project?", nist_category: "protect", type: "yesno", options: ["Yes", "No"], risk_if_no: "Without MFA, stolen passwords give full access." },
      { id: 3, question: "Do you have backups of your data?", nist_category: "recover", type: "yesno", options: ["Yes", "No"], risk_if_no: "No backups means data loss is permanent after an attack." },
      { id: 4, question: "Has anyone reviewed this codebase for security issues before?", nist_category: "identify", type: "yesno", options: ["Yes", "No"], risk_if_no: "Unreviewed code often contains hidden vulnerabilities." },
      { id: 5, question: "Do you have a plan for what to do if this app gets hacked?", nist_category: "respond", type: "yesno", options: ["Yes", "No"], risk_if_no: "No incident response plan means slow, chaotic reaction to breaches." },
      { id: 6, question: "Do you monitor your app for unusual activity or errors?", nist_category: "detect", type: "yesno", options: ["Yes", "No"], risk_if_no: "Without monitoring you won't know you've been attacked." },
    ];
  }
}

// ─── Call 6: Final report combining scan + question answers ───
async function generateFinalReport(repoName, fileSummaries, questions, answers) {
  const system = loadPrompt('final_report');

  const summariesText = fileSummaries
    .map(s => `FILE: ${s.file}\nISSUES: ${JSON.stringify(s.issues)}`)
    .join('\n---\n');

  const answersText = questions.map((q, i) => (
    `Q: ${q.question} (NIST: ${q.nist_category})\nA: ${answers[i] || 'Not answered'}\nRisk if bad: ${q.risk_if_no}`
  )).join('\n\n');

  const userMessage = `Repository: ${repoName}

CODE SCAN FINDINGS:
${summariesText}

QUESTIONNAIRE ANSWERS:
${answersText}`;

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
  generateQuestions,
  generateFinalReport,
};

// ─── Pass 2A: Find related file groups ───────────────────────
async function findRelatedFiles(fileSummaries) {
  const system = loadPrompt('related_files');

  const summariesText = fileSummaries
    .map(s => `FILE: ${s.file}\nSUMMARY: ${s.summary}\nISSUES FOUND: ${s.issues?.length || 0}`)
    .join('\n---\n');

  const response = await callClaude(system, summariesText, 600);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { related_groups: [] };
  }
}

// ─── Pass 2B: Deep combined analysis of related files ─────────
async function analyzeRelatedFiles(filePaths, fileContents, existingSummaries) {
  const system = `You are a cybersecurity expert doing a deep cross-file security analysis.
You are analyzing multiple files TOGETHER because they interact with each other.
Look for vulnerabilities that only become visible when you see how these files work together.

Examples of cross-file vulnerabilities:
- Data from one file passed unsafely into another
- Authentication checked in one file but bypassed via another
- Secrets or tokens passed between files
- Inconsistent validation across files
- Trust boundaries violated between modules

Return ONLY a JSON object. No markdown. Raw JSON only.

Format:
{
  "cross_file_issues": [
    {
      "title": "short title",
      "description": "plain English explanation referencing specific files",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "nist_category": "identify|protect|detect|respond|recover",
      "files_involved": ["file1.js", "file2.js"],
      "fix": "specific fix"
    }
  ],
  "interaction_summary": "one sentence about how these files interact"
}`;

  const existingSummaryText = existingSummaries
    .filter(s => filePaths.includes(s.file))
    .map(s => `FILE: ${s.file}\nINDIVIDUAL ISSUES: ${JSON.stringify(s.issues)}`)
    .join('\n---\n');

  const fileContentText = filePaths
    .map(f => `=== ${f} ===\n${fileContents[f] || '(content not available)'}`)
    .join('\n\n');

  const userMessage = `Individual analysis summaries:\n${existingSummaryText}\n\nActual file contents:\n${fileContentText}`;

  const response = await callClaude(system, userMessage, 1200);

  try {
    const clean = response.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { cross_file_issues: [], interaction_summary: '' };
  }
}

module.exports = {
  selectFilesToAnalyze,
  analyzeFile,
  analyzeCommitHistory,
  generateMasterReport,
  generateQuestions,
  generateFinalReport,
  findRelatedFiles,
  analyzeRelatedFiles,
};
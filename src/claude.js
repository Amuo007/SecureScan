const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

function loadPrompt(name) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  return fs.readFileSync(filePath, 'utf-8').trim();
}

async function callClaude(systemPrompt, userMessage, maxTokens = 2000) {
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

function parseJson(raw, fallback) {
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return fallback;
  }
}

// ── Call 1: Decide which files to analyze ─────────────────────
async function selectFilesToAnalyze(fileTree) {
  const system = loadPrompt('select_files');
  const userMessage = `Here is the file tree for this repository:\n\n${fileTree.join('\n')}\n\nWhich files should I analyze for security issues?`;
  const response = await callClaude(system, userMessage, 500);
  return parseJson(response, fileTree.filter(f =>
    /\.(env|config|json|yaml|yml|js|ts|py|rb|php|sh)$/i.test(f) ||
    /(auth|secret|key|password|token|config|login|security)/i.test(f)
  ).slice(0, 15));
}

// ── Call 2: Analyze a single file — thorough, confirmed + suspected ──
async function analyzeFile(filePath, fileContent) {
  const system = loadPrompt('analyze_file');
  const userMessage = `File: ${filePath}\n\nContent:\n${fileContent}`;
  const response = await callClaude(system, userMessage, 3000);
  return parseJson(response, {
    file: filePath,
    summary: 'Could not parse analysis',
    issues: [],
    safe_practices: [],
  });
}

// ── Call 3: Analyze commit history findings ───────────────────
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
  return parseJson(response, {
    file: 'git_history',
    summary: 'Suspicious patterns found in commit history',
    issues: commitFindings.suspicious_commits.map(f => ({
      title: `Potential secret in commit ${f.sha}`,
      description: `A pattern matching secret credentials was found in ${f.file}`,
      confidence: 'suspected',
      severity: 'HIGH',
      nist_category: 'protect',
      fix: 'Rotate any credentials that were ever committed. Use git-filter-repo to clean history.',
    })),
    safe_practices: [],
  });
}

// ── Call 4: Generate questions — 2 per NIST component, business language ──
async function generateQuestions(repoName, fileSummaries) {
  const system = loadPrompt('generate_questions');
  const summariesText = fileSummaries.map(s => {
    const confirmedIssues = (s.issues || []).filter(i => i.confidence === 'confirmed');
    const suspectedIssues = (s.issues || []).filter(i => i.confidence === 'suspected');
    return [
      `FILE: ${s.file} — ${s.summary}`,
      confirmedIssues.length ? `  Confirmed issues: ${confirmedIssues.map(i => i.title).join(', ')}` : '',
      suspectedIssues.length ? `  Suspected issues: ${suspectedIssues.map(i => i.title).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const userMessage = `Repository: ${repoName}\n\nWhat the scan found:\n${summariesText}\n\nGenerate 10 questions (2 per NIST category) for the business owner.`;
  const response = await callClaude(system, userMessage, 2000);
  return parseJson(response, getDefaultQuestions());
}

// ── Calls 5a–5e: Deep dive per NIST category ─────────────────
async function analyzeNistCategory(category, fileSummaries, questions, answers) {
  const system = loadPrompt(`nist_${category}`);

  const summariesText = fileSummaries
    .map(s => `FILE: ${s.file}\nSUMMARY: ${s.summary}\nISSUES: ${JSON.stringify(s.issues || [])}`)
    .join('\n---\n');

  const relevantQA = questions
    .map((q, i) => ({ q, a: answers[i] }))
    .filter(({ q }) => q.nist_category === category)
    .map(({ q, a }) => `Q: ${q.question}\nA: ${a || 'Not answered'}\nRisk if bad: ${q.risk_if_bad}`)
    .join('\n\n');

  const userMessage = [
    `Repository code scan findings:\n${summariesText}`,
    relevantQA ? `\nQuestionnaire answers for ${category}:\n${relevantQA}` : '',
  ].join('');

  const response = await callClaude(system, userMessage, 3000);
  return parseJson(response, {
    nist_category: category,
    findings: [],
    raw_counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    category_summary: `Could not analyze ${category} category`,
  });
}

// ── Call 6: Merge all 5 NIST analyses into final report ───────
async function mergeFinalReport(repoName, nistResults, questions, answers) {
  const system = loadPrompt('final_report');

  // Send summaries + counts only — not full findings JSON (too large)
  const nistText = nistResults.map(r => {
    const topFindings = (r.findings || [])
      .sort((a, b) => {
        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
      })
      .slice(0, 10) // top 10 per category max
      .map(f => `  [${f.severity}][${f.confidence}] ${f.title} (${f.file}): ${f.description} — Fix: ${f.fix}`)
      .join('\n');
    return `CATEGORY: ${r.nist_category.toUpperCase()}\nSUMMARY: ${r.category_summary}\nCOUNTS: ${JSON.stringify(r.raw_counts)}\nTOP FINDINGS:\n${topFindings}`;
  }).join('\n\n===\n\n');

  const rawCountsAll = {};
  for (const r of nistResults) {
    rawCountsAll[r.nist_category] = r.raw_counts;
  }

  const answersText = questions.map((q, i) =>
    `Q(${q.nist_category}): ${q.question}\nA: ${answers[i] || 'Not answered'}`
  ).join('\n');

  const userMessage = [
    `Repository: ${repoName}`,
    `\nNIST CATEGORY ANALYSES:\n${nistText}`,
    `\nRAW COUNTS (do not change these):\n${JSON.stringify(rawCountsAll, null, 2)}`,
    `\nQUESTIONNAIRE ANSWERS:\n${answersText}`,
  ].join('');

  console.log('Merge prompt length (chars):', userMessage.length);

  const response = await callClaude(system, userMessage, 6000);

  console.log('Merge raw response (first 300):', response.slice(0, 300));

  const parsed = parseJson(response, null);
  if (!parsed) {
    console.error('Merge parse failed. Full response:', response);
  }
  return parsed;
}

// ── Default questions fallback ────────────────────────────────
function getDefaultQuestions() {
  return [
    { id: 1, nist_category: 'identify', question: 'Do you know exactly what personal or business data your system stores?', why_asking: 'Assess data inventory awareness', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Without knowing what data is stored, you cannot protect it or report a breach properly.' },
    { id: 2, nist_category: 'identify', question: 'Does your team have a list of all the tools and services your system depends on?', why_asking: 'Third party dependency inventory', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Unknown dependencies can become unexpected security gaps.' },
    { id: 3, nist_category: 'protect', question: 'Does every person who accesses this system have their own separate login?', why_asking: 'Shared credential risk', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Shared logins make it impossible to track who did what and make credential theft much more damaging.' },
    { id: 4, nist_category: 'protect', question: 'Do you use two-step verification on accounts connected to this system?', why_asking: 'MFA adoption', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Without two-step verification, a stolen password gives full access immediately.' },
    { id: 5, nist_category: 'detect', question: 'Would you know if someone was trying to break into your system right now?', why_asking: 'Monitoring awareness', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Without monitoring, attacks can go undetected for months causing much greater damage.' },
    { id: 6, nist_category: 'detect', question: 'Do you receive any automatic alerts when your system has an error or unusual activity?', why_asking: 'Alerting capability', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Silent failures mean attacks and outages go unnoticed until customers report them.' },
    { id: 7, nist_category: 'respond', question: 'Does your team have a written plan for what to do if your system gets hacked?', why_asking: 'Incident response plan', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'No plan means slow chaotic response during a breach, increasing damage and recovery cost.' },
    { id: 8, nist_category: 'respond', question: 'Can you immediately cut off access for a team member or system account if needed?', why_asking: 'Access revocation capability', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Inability to quickly revoke access means a compromised account can cause damage for longer.' },
    { id: 9, nist_category: 'recover', question: 'Do you have recent backups of all your business data that you have tested?', why_asking: 'Backup and recovery', type: 'yesno', options: ['Yes', 'No'], risk_if_bad: 'Without tested backups, data loss from an attack is permanent.' },
    { id: 10, nist_category: 'recover', question: 'If your system was completely wiped today, how long would it take to get back to normal?', why_asking: 'Recovery time awareness', type: 'choice', options: ['Less than a day', '1–3 days', 'More than a week', 'We do not know'], risk_if_bad: 'Long or unknown recovery time means extended business disruption after an incident.' },
  ];
}

module.exports = {
  selectFilesToAnalyze,
  analyzeFile,
  analyzeCommitHistory,
  generateQuestions,
  analyzeNistCategory,
  mergeFinalReport,
};
You are a cybersecurity expert. Analyze these suspicious patterns found in a git repository's commit history.

These patterns suggest secrets or credentials may have been committed to the repository at some point — even if later deleted, they are still in git history and potentially compromised.

Anyone who cloned the repo before the deletion still has access to those secrets.

Return ONLY a JSON object. No markdown. Raw JSON only.

Format:
{
  "file": "git_history",
  "summary": "one sentence summary of findings",
  "language": "",
  "imports": [],
  "exports": [],
  "functions": [],
  "api_endpoints": [],
  "env_vars_used": [],
  "db_queries": [],
  "issues": [
    {
      "title": "short title",
      "description": "plain English explanation of what was found and why it is dangerous",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "nist_category": "identify|protect|detect|respond|recover",
      "fix": "specific fix — always mention rotating credentials",
      "line_snippet": "the suspicious pattern found"
    }
  ],
  "safe_practices": []
}
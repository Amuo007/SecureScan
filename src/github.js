const axios = require('axios');

// ─── Base GitHub API call ──────────────────────────────────────
function gh(token) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
}

// ─── Get full file tree (just paths, no content) ──────────────
async function getFileTree(token, owner, repo) {
  const api = gh(token);

  // Get default branch first
  const repoRes = await api.get(`/repos/${owner}/${repo}`);
  const branch = repoRes.data.default_branch;

  // Get recursive tree — all file paths in one call
  const treeRes = await api.get(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  );

  // Return just the file paths (not dirs)
  const files = treeRes.data.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path);

  return { files, branch };
}

// ─── Get content of a single file ─────────────────────────────
async function getFileContent(token, owner, repo, filePath) {
  const api = gh(token);
  try {
    const res = await api.get(`/repos/${owner}/${repo}/contents/${filePath}`);

    // GitHub returns base64 encoded content
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');

    // Truncate if over 300 lines — we only need the security-relevant parts
    const lines = content.split('\n');
    if (lines.length > 300) {
      return lines.slice(0, 300).join('\n') + '\n... (truncated at 300 lines)';
    }

    return content;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// ─── Get latest commit SHA ────────────────────────────────────
async function getLatestCommitSha(token, owner, repo) {
  const api = gh(token);
  const repoRes = await api.get(`/repos/${owner}/${repo}`);
  const branch = repoRes.data.default_branch;

  const commitRes = await api.get(`/repos/${owner}/${repo}/commits/${branch}`);
  return commitRes.data.sha;
}

// ─── Get changed files since last scan ───────────────────────
async function getChangedFilesSince(token, owner, repo, sinceSha) {
  const api = gh(token);
  try {
    const res = await api.get(`/repos/${owner}/${repo}/compare/${sinceSha}...HEAD`);
    return res.data.files.map(f => f.filename);
  } catch {
    return null; // if compare fails, return null → trigger full scan
  }
}

// ─── Get commit history and diffs for secret leak detection ───
async function getCommitHistory(token, owner, repo) {
  const api = gh(token);

  // Get last 30 commits
  const commitsRes = await api.get(`/repos/${owner}/${repo}/commits`, {
    params: { per_page: 30 }
  });

  const suspiciousFindings = [];

  // Secret patterns to look for
  const secretPatterns = [
    /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}/i,
    /secret\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}/i,
    /password\s*[:=]\s*['"]?[^\s'"]{8,}/i,
    /token\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}/i,
    /private[_-]?key\s*[:=]/i,
    /aws[_-]?(access|secret)/i,
    /sk-[a-zA-Z0-9]{32,}/,  // OpenAI keys
    /ghp_[a-zA-Z0-9]{36}/,  // GitHub personal tokens
  ];

  // Check last 10 commits for secret patterns in diffs
  const commitsToCheck = commitsRes.data.slice(0, 10);

  for (const commit of commitsToCheck) {
    try {
      const diffRes = await api.get(`/repos/${owner}/${repo}/commits/${commit.sha}`);
      const files = diffRes.data.files || [];

      for (const file of files) {
        const patch = file.patch || '';
        for (const pattern of secretPatterns) {
          if (pattern.test(patch)) {
            suspiciousFindings.push({
              sha: commit.sha.slice(0, 7),
              file: file.filename,
              message: commit.commit.message,
              date: commit.commit.author.date,
              pattern: pattern.source,
            });
            break; // one finding per file per commit is enough
          }
        }
      }
    } catch {
      continue; // skip commits we can't fetch
    }
  }

  return {
    total_commits: commitsRes.data.length,
    suspicious_commits: suspiciousFindings,
  };
}

// ─── Get multiple files in parallel ──────────────────────────
async function getMultipleFiles(token, owner, repo, filePaths) {
  const results = {};

  // Fetch up to 5 files at a time in parallel
  const chunks = [];
  for (let i = 0; i < filePaths.length; i += 5) {
    chunks.push(filePaths.slice(i, i + 5));
  }

  for (const chunk of chunks) {
    const fetched = await Promise.all(
      chunk.map(async (filePath) => ({
        path: filePath,
        content: await getFileContent(token, owner, repo, filePath),
      }))
    );
    fetched.forEach(({ path, content }) => {
      if (content) results[path] = content;
    });
  }

  return results;
}

module.exports = {
  getFileTree,
  getFileContent,
  getLatestCommitSha,
  getChangedFilesSince,
  getCommitHistory,
  getMultipleFiles,
};
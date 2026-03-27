const github = require('./github');
const claude = require('./claude');
const db = require('./db');

// ─── Main scan function ───────────────────────────────────────
// emit(message) sends live progress updates to the frontend via SSE
async function scanRepo({ token, githubLogin, owner, repo, emit }) {
  const repoFullName = `${owner}/${repo}`;

  try {
    // ── Step 1: Check latest commit SHA ──────────────────────
    emit('status', 'Checking repository for changes...');
    const latestSha = await github.getLatestCommitSha(token, owner, repo);
    const savedSha = await db.getLastCommitSha(githubLogin, repoFullName);

    // ── Step 2: If nothing changed, return cached result ─────
    if (savedSha && savedSha === latestSha) {
      emit('status', 'No changes since last scan. Loading cached results...');
      const cached = await db.getScan(githubLogin, repoFullName);
      emit('done', cached.result);
      return cached.result;
    }

    // ── Step 3: Get file tree ─────────────────────────────────
    emit('status', 'Fetching repository file structure...');
    const { files } = await github.getFileTree(token, owner, repo);
    emit('status', `Found ${files.length} files in repository.`);

    // ── Step 4: If rescan, only get changed files ─────────────
    let filesToFetch;
    if (savedSha) {
      emit('status', 'Detecting changed files since last scan...');
      const changedFiles = await github.getChangedFilesSince(token, owner, repo, savedSha);

      if (changedFiles && changedFiles.length > 0) {
        emit('status', `${changedFiles.length} files changed since last scan.`);
        // Only ask Claude to pick from changed files
        filesToFetch = changedFiles;
      } else {
        emit('status', 'Could not detect changes. Running full scan...');
        filesToFetch = files;
      }
    } else {
      filesToFetch = files;
    }

    // ── Step 5: Claude selects which files to analyze ─────────
    emit('status', 'AI selecting security-relevant files to analyze...');
    const selectedFiles = await claude.selectFilesToAnalyze(filesToFetch);
    emit('status', `AI selected ${selectedFiles.length} files for security analysis.`);

    // ── Step 6: Fetch file contents ───────────────────────────
    emit('status', 'Fetching file contents...');
    const fileContents = await github.getMultipleFiles(token, owner, repo, selectedFiles);

    // ── Step 7: Analyze each file — fresh Claude call each ────
    const fileSummaries = [];

    for (const filePath of Object.keys(fileContents)) {
      emit('status', `Analyzing ${filePath}...`);
      const analysis = await claude.analyzeFile(filePath, fileContents[filePath]);
      fileSummaries.push(analysis);
    }

    // ── Step 8: Check commit history for leaked secrets ───────
    emit('status', 'Scanning commit history for leaked secrets...');
    const commitFindings = await github.getCommitHistory(token, owner, repo);
    const commitAnalysis = await claude.analyzeCommitHistory(commitFindings);
    fileSummaries.push(commitAnalysis);

    // ── Step 9: If rescan, merge with old summaries ───────────
    let allSummaries = fileSummaries;
    if (savedSha) {
      const oldScan = await db.getScan(githubLogin, repoFullName);
      if (oldScan?.file_summaries) {
        // Keep old summaries for files that weren't re-analyzed
        const newFilePaths = new Set(fileSummaries.map(s => s.file));
        const oldUnchanged = oldScan.file_summaries.filter(s => !newFilePaths.has(s.file));
        allSummaries = [...fileSummaries, ...oldUnchanged];
      }
    }

    // ── Step 10: Generate master report ───────────────────────
    emit('status', 'Generating final security report...');
    const masterReport = await claude.generateMasterReport(repoFullName, allSummaries);

    if (!masterReport) {
      emit('error', 'Failed to generate final report.');
      return null;
    }

    // ── Step 11: Save to database ─────────────────────────────
    emit('status', 'Saving results...');
    await db.saveScan({
      githubLogin,
      repoFullName,
      lastCommitSha: latestSha,
      result: masterReport,
      fileSummaries: allSummaries,
    });

    // ── Step 12: Done ─────────────────────────────────────────
    emit('done', masterReport);
    return masterReport;

  } catch (err) {
    console.error('Scan error:', err.message);
    emit('error', `Scan failed: ${err.message}`);
    return null;
  }
}

module.exports = { scanRepo };
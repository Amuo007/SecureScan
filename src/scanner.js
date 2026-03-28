const github = require('./github');
const claude = require('./claude');
const db = require('./db');

async function scanRepo({ token, githubLogin, owner, repo, emit }) {
  const repoFullName = `${owner}/${repo}`;
  try {
    // ── Check commit SHA ──────────────────────────────────────
    emit('status', 'Checking repository for changes...');
    const latestSha = await github.getLatestCommitSha(token, owner, repo);
    const savedSha = await db.getLastCommitSha(githubLogin, repoFullName);

    if (savedSha && savedSha === latestSha) {
      emit('status', 'No changes since last scan. Loading cached results...');
      const cached = await db.getScan(githubLogin, repoFullName);
      if (cached?.result) { emit('done', cached.result); return cached.result; }
    }

    // ── Get full file tree ────────────────────────────────────
    emit('status', 'Fetching repository file structure...');
    const { files } = await github.getFileTree(token, owner, repo);
    emit('status', `Found ${files.length} files in repository.`);

    // ── Detect changed files if rescan ────────────────────────
    let filesToFetch = files;
    if (savedSha) {
      emit('status', 'Detecting changed files since last scan...');
      const changedFiles = await github.getChangedFilesSince(token, owner, repo, savedSha);
      if (changedFiles && changedFiles.length > 0) {
        emit('status', `${changedFiles.length} files changed since last scan.`);
        filesToFetch = changedFiles;
      }
    }

    // ── Claude selects files ──────────────────────────────────
    emit('status', 'AI selecting security-relevant files to analyze...');
    const selectedFiles = await claude.selectFilesToAnalyze(filesToFetch);
    emit('status', `AI selected ${selectedFiles.length} files for analysis.`);

    // ── Fetch file contents ───────────────────────────────────
    emit('status', 'Fetching file contents...');
    const fileContents = await github.getMultipleFiles(token, owner, repo, selectedFiles);

    // ── Analyze each file (rich extraction) ───────────────────
    emit('status', 'Analyzing files...');
    const fileSummaries = [];
    for (const filePath of Object.keys(fileContents)) {
      emit('status', `Analyzing ${filePath}...`);
      const analysis = await claude.analyzeFile(filePath, fileContents[filePath]);
      fileSummaries.push(analysis);
    }

    // ── Commit history ────────────────────────────────────────
    emit('status', 'Scanning commit history for leaked secrets...');
    const commitFindings = await github.getCommitHistory(token, owner, repo);
    const commitAnalysis = await claude.analyzeCommitHistory(commitFindings);
    fileSummaries.push(commitAnalysis);

    // ── Merge with old summaries if rescan ────────────────────
    let allSummaries = fileSummaries;
    if (savedSha) {
      const oldScan = await db.getScan(githubLogin, repoFullName);
      if (oldScan?.file_summaries) {
        const newFilePaths = new Set(fileSummaries.map(s => s.file));
        const oldUnchanged = oldScan.file_summaries.filter(s => !newFilePaths.has(s.file));
        allSummaries = [...fileSummaries, ...oldUnchanged];
      }
    }

    // ── Build cross file map ──────────────────────────────────
    emit('status', 'Building cross-file dependency map...');
    const crossFileMap = {};
    for (const summary of allSummaries) {
      if (summary.imports && summary.imports.length > 0) {
        crossFileMap[summary.file] = summary.imports;
      }
    }

    // ── Build master report object ────────────────────────────
    emit('status', 'Building master report...');
    const filesMap = {};
    for (const summary of allSummaries) {
      filesMap[summary.file] = summary;
    }

    const masterData = {
      repo: repoFullName,
      scanned_at: new Date().toISOString(),
      file_tree: files,
      files: filesMap,
      cross_file_map: crossFileMap,
      final_report: null, // filled after questions
    };

    // ── Generate questions ────────────────────────────────────
    emit('status', 'Generating personalized security questions...');
    const questions = await claude.generateQuestions(repoFullName, allSummaries);

    // ── Save to DB ────────────────────────────────────────────
    emit('status', 'Saving scan results...');
    await db.saveScan({
      githubLogin,
      repoFullName,
      lastCommitSha: latestSha,
      result: null,
      fileSummaries: allSummaries,
      fileTree: files,
      masterData,
      questions,
      pendingQuestions: true,
    });

    emit('questions', { questions, repo: repoFullName });

  } catch (err) {
    console.error('Scan error:', err.message);
    emit('error', `Scan failed: ${err.message}`);
  }
}

async function generateFinalReport({ githubLogin, repoFullName, answers }) {
  const scan = await db.getScan(githubLogin, repoFullName);
  if (!scan) throw new Error('No scan found');

  const questions = scan.questions ? JSON.parse(scan.questions) : [];
  const fileSummaries = scan.file_summaries || [];
  const masterData = scan.master_data ? JSON.parse(scan.master_data) : {};

  const report = await claude.generateFinalReport(repoFullName, fileSummaries, questions, answers);
  if (!report) throw new Error('Failed to generate report');

  // Attach final report into master data
  masterData.final_report = report;

  await db.saveScan({
    githubLogin,
    repoFullName,
    lastCommitSha: scan.last_commit_sha,
    result: report,
    fileSummaries,
    fileTree: masterData.file_tree || [],
    masterData,
    questions,
    pendingQuestions: false,
  });

  return report;
}

module.exports = { scanRepo, generateFinalReport };
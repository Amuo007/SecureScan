const github = require('./github');
const claude = require('./claude');
const db = require('./db');

// ── All score math lives here — Claude never calculates scores ──
function calculateScore(rawCounts, questions, answers) {
  const weights = { CRITICAL: 20, HIGH: 10, MEDIUM: 5, LOW: 2 };
  const categories = ['identify', 'protect', 'detect', 'respond', 'recover'];

  const categoryScores = {};
  let totalRaw = 0;

  for (const cat of categories) {
    const counts = rawCounts[cat] || {};
    let raw = 0;
    for (const [sev, pts] of Object.entries(weights)) {
      raw += (counts[sev] || 0) * pts;
    }
    categoryScores[cat] = raw;
    totalRaw += raw;
  }

  // Add question penalties for bad answers
  if (questions && answers) {
    questions.forEach((q, i) => {
      const answer = answers[i];
      if (!answer) return;
      const isBadAnswer = answer === 'No' || answer === q.options[q.options.length - 1];
      if (isBadAnswer) {
        const riskText = (q.risk_if_bad || '').toLowerCase();
        const isHighRisk = riskText.includes('data loss') ||
          riskText.includes('unauthorized') ||
          riskText.includes('no plan') ||
          riskText.includes('permanent');
        const penalty = isHighRisk ? 10 : 5;
        categoryScores[q.nist_category] = (categoryScores[q.nist_category] || 0) + penalty;
        totalRaw += penalty;
      }
    });
  }

  for (const cat of categories) {
    categoryScores[cat] = Math.min(categoryScores[cat] || 0, 100);
  }

  const overallScore = Math.min(totalRaw, 100);
  const riskLevel =
    overallScore <= 25 ? 'LOW' :
    overallScore <= 50 ? 'MEDIUM' :
    overallScore <= 75 ? 'HIGH' : 'CRITICAL';

  return { overallScore, riskLevel, categoryScores };
}

// ── Main scan — runs through to questions, saves, emits questions event ──
async function scanRepo({ token, githubLogin, owner, repo, emit }) {
  const repoFullName = `${owner}/${repo}`;
  try {
    emit('status', 'Checking repository for changes...');
    const latestSha = await github.getLatestCommitSha(token, owner, repo);
    const savedScan = await db.getScan(githubLogin, repoFullName);
    const savedSha = savedScan?.last_commit_sha || null;

    if (savedSha && savedSha === latestSha && savedScan?.result) {
      emit('status', 'No changes since last scan. Loading cached results...');
      emit('done', savedScan.result);
      return savedScan.result;
    }

    emit('status', 'Fetching repository file structure...');
    const { files } = await github.getFileTree(token, owner, repo);
    emit('status', `Found ${files.length} files in repository.`);

    let filesToFetch = files;
    if (savedSha) {
      emit('status', 'Detecting changed files since last scan...');
      const changedFiles = await github.getChangedFilesSince(token, owner, repo, savedSha);
      if (changedFiles && changedFiles.length > 0) {
        emit('status', `${changedFiles.length} files changed since last scan.`);
        filesToFetch = changedFiles;
      }
    }

    emit('status', 'AI selecting security-relevant files to analyze...');
    const selectedFiles = await claude.selectFilesToAnalyze(filesToFetch);
    emit('status', `Analyzing ${selectedFiles.length} files...`);

    emit('status', 'Fetching file contents...');
    const fileContents = await github.getMultipleFiles(token, owner, repo, selectedFiles);

    // Analyze each file — thorough, confirmed + suspected
    const fileSummaries = [];
    for (const filePath of Object.keys(fileContents)) {
      emit('status', `Analyzing ${filePath}...`);
      const analysis = await claude.analyzeFile(filePath, fileContents[filePath]);
      analysis.raw_content = fileContents[filePath];
      fileSummaries.push(analysis);
    }

    emit('status', 'Scanning commit history for leaked secrets...');
    const commitFindings = await github.getCommitHistory(token, owner, repo);
    const commitAnalysis = await claude.analyzeCommitHistory(commitFindings);
    fileSummaries.push(commitAnalysis);

    // Merge with old summaries if incremental rescan
    let allSummaries = fileSummaries;
    if (savedSha && savedScan?.file_summaries) {
      const newFilePaths = new Set(fileSummaries.map(s => s.file));
      const oldUnchanged = savedScan.file_summaries.filter(s => !newFilePaths.has(s.file));
      allSummaries = [...fileSummaries, ...oldUnchanged];
    }

    // Build cross-file map
    const crossFileMap = {};
    for (const summary of allSummaries) {
      if (summary.imports?.length > 0) {
        crossFileMap[summary.file] = summary.imports;
      }
    }

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
      nist_results: null,
      final_report: null,
    };

    emit('status', 'Generating security questions for your team...');
    const questions = await claude.generateQuestions(repoFullName, allSummaries);

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

// ── Final report — runs after questionnaire answers come back ──
async function generateFinalReport({ githubLogin, repoFullName, answers }) {
  const scan = await db.getScan(githubLogin, repoFullName);
  if (!scan) throw new Error('No scan found');

  const questions = scan.questions ? JSON.parse(scan.questions) : [];
  const fileSummaries = scan.file_summaries || [];
  const masterData = scan.master_data ? JSON.parse(scan.master_data) : {};

  // 5 deep-dive NIST calls — one per category
  const nistCategories = ['identify', 'protect', 'detect', 'respond', 'recover'];
  const nistResults = [];

  for (const category of nistCategories) {
    console.log(`Running NIST ${category} analysis...`);
    const result = await claude.analyzeNistCategory(category, fileSummaries, questions, answers);
    nistResults.push(result);
  }

  // Merge call — combines all 5, deduplicates, produces final report
  console.log('Merging NIST analyses into final report...');
  const mergedReport = await claude.mergeFinalReport(repoFullName, nistResults, questions, answers);
  if (!mergedReport) throw new Error('Failed to generate final report');

  // Attach raw counts from NIST results
  const rawCounts = {};
  for (const r of nistResults) {
    rawCounts[r.nist_category] = r.raw_counts;
  }

  // Calculate score in code — not by Claude
  const { overallScore, riskLevel, categoryScores } = calculateScore(rawCounts, questions, answers);

  const finalReport = {
    ...mergedReport,
    overall_score: overallScore,
    risk_level: riskLevel,
    category_scores: categoryScores,
    raw_counts: rawCounts,
  };

  masterData.nist_results = nistResults;
  masterData.final_report = finalReport;

  await db.saveScan({
    githubLogin,
    repoFullName,
    lastCommitSha: scan.last_commit_sha,
    result: finalReport,
    fileSummaries,
    fileTree: masterData.file_tree || [],
    masterData,
    questions,
    pendingQuestions: false,
  });

  return finalReport;
}

module.exports = { scanRepo, generateFinalReport, calculateScore };
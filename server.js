require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) { return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8').trim(); }
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const { scanRepo, generateFinalReport } = require('./src/scanner');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

function requireAuth(req, res, next) {
  if (!req.session.token) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/auth/github', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: 'http://localhost:3000/auth/callback',
    scope: 'repo read:user',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      { client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code },
      { headers: { Accept: 'application/json' } }
    );
    const { access_token, error } = tokenRes.data;
    if (error || !access_token) return res.redirect('/?error=token_failed');
    req.session.token = access_token;
    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    req.session.user = { login: userRes.data.login, avatar_url: userRes.data.avatar_url, name: userRes.data.name };
    res.redirect('/repos.html');
  } catch (err) {
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/api/repos', requireAuth, async (req, res) => {
  try {
    let allRepos = [], page = 1;
    while (true) {
      const response = await axios.get('https://api.github.com/user/repos', {
        headers: { Authorization: `Bearer ${req.session.token}` },
        params: { per_page: 100, page, sort: 'updated', affiliation: 'owner' }
      });
      allRepos = allRepos.concat(response.data);
      if (response.data.length < 100) break;
      page++;
    }
    const savedScans = await db.getUserScans(req.session.user.login);
    const scanMap = {};
    savedScans.forEach(s => { scanMap[s.repo_full_name] = s; });
    const repos = allRepos.map(repo => ({
      id: repo.id, name: repo.name, full_name: repo.full_name,
      description: repo.description, private: repo.private,
      language: repo.language, updated_at: repo.updated_at,
      default_branch: repo.default_branch,
      last_scan: scanMap[repo.full_name] || null,
    }));
    res.json({ repos, user: req.session.user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.session.user }));

app.get('/api/scan/:owner/:repo', requireAuth, async (req, res) => {
  const repoFullName = `${req.params.owner}/${req.params.repo}`;
  try {
    const scan = await db.getScan(req.session.user.login, repoFullName);
    if (!scan) return res.status(404).json({ error: 'No scan found' });
    res.json(scan.result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE scan stream
app.get('/api/scan/stream/:owner/:repo', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function emit(type, data) {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  try {
    await scanRepo({ token: req.session.token, githubLogin: req.session.user.login, owner, repo, emit });
  } catch (err) {
    emit('error', err.message);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// Submit questionnaire answers → generate final report
app.post('/api/report', requireAuth, async (req, res) => {
  const { repo, answers } = req.body;
  try {
    const report = await generateFinalReport({
      githubLogin: req.session.user.login,
      repoFullName: repo,
      answers,
    });
    res.json(report);
  } catch (err) {
    console.error('Report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.listen(PORT, () => console.log(`✅ SecureScan running at http://localhost:${PORT}`));

// Chat route
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, repo, context } = req.body;
  try {
    // Load master data from DB — has everything
    const scan = await db.getScan(req.session.user.login, repo);
    const masterData = scan?.master_data ? JSON.parse(scan.master_data) : null;

    // Build rich context for Claude
    let richContext = '';

    if (masterData) {
      // File tree
      const fileTree = masterData.file_tree || [];
      richContext += `\n\nFULL FILE TREE:\n${fileTree.join('\n')}`;

      // Per file rich data — functions, imports, endpoints, queries
      const filesMap = masterData.files || {};
      const fileDetails = Object.entries(filesMap).map(([fname, fdata]) => {
        let detail = `\nFILE: ${fname}`;
        detail += `\n  Summary: ${fdata.summary || ''}`;
        if (fdata.language) detail += `\n  Language: ${fdata.language}`;
        if (fdata.imports?.length) detail += `\n  Imports: ${fdata.imports.join(', ')}`;
        if (fdata.exports?.length) detail += `\n  Exports: ${fdata.exports.join(', ')}`;
        if (fdata.functions?.length) detail += `\n  Functions: ${fdata.functions.map(f => f.name + '() — ' + f.description).join(', ')}`;
        if (fdata.api_endpoints?.length) detail += `\n  API Endpoints: ${fdata.api_endpoints.join(', ')}`;
        if (fdata.env_vars_used?.length) detail += `\n  Env vars: ${fdata.env_vars_used.join(', ')}`;
        if (fdata.db_queries?.length) detail += `\n  DB Queries: ${fdata.db_queries.join(' | ')}`;
        if (fdata.raw_content) detail += `\n  Raw Content:\n\`\`\`\n${fdata.raw_content.slice(0, 2000)}\n\`\`\``;
        return detail;
      }).join('\n---');

      richContext += `\n\nDETAILED FILE ANALYSIS:\n${fileDetails}`;

      // Cross file map
      if (masterData.cross_file_map && Object.keys(masterData.cross_file_map).length) {
        richContext += `\n\nCROSS-FILE DEPENDENCIES:\n${JSON.stringify(masterData.cross_file_map, null, 2)}`;
      }
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: loadPrompt('chat_system') + `\n\nREPO: ${repo}\nSCAN SUMMARY: ${context.summary}\nVULNERABILITIES: ${JSON.stringify(context.vulnerabilities)}\nRECOMMENDATIONS: ${JSON.stringify(context.recommendations)}\n${richContext}`,
        messages: [{ role: 'user', content: message }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        }
      }
    );
    res.json({ reply: response.data.content[0].text });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed' });
  }
});
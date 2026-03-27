require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true if using HTTPS
}));

// ─── Auth Guard ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.token) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// ─── ROUTES ───────────────────────────────────────────────────

// Home → login page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Step 1: Redirect user to GitHub OAuth
app.get('/auth/github', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: 'http://localhost:3000/auth/callback',
    scope: 'repo read:user',  // repo = public + private repos
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Step 2: GitHub redirects back here with a code
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      },
      { headers: { Accept: 'application/json' } }
    );

    const { access_token, error } = tokenRes.data;

    if (error || !access_token) {
      console.error('Token error:', tokenRes.data);
      return res.redirect('/?error=token_failed');
    }

    // Save token + fetch user info
    req.session.token = access_token;

    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    req.session.user = {
      login: userRes.data.login,
      avatar_url: userRes.data.avatar_url,
      name: userRes.data.name,
    };

    res.redirect('/repos.html');

  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Step 3: Get all repos (public + private)
app.get('/api/repos', requireAuth, async (req, res) => {
  try {
    let allRepos = [];
    let page = 1;

    // GitHub paginates — fetch all pages
    while (true) {
      const response = await axios.get('https://api.github.com/user/repos', {
        headers: { Authorization: `Bearer ${req.session.token}` },
        params: {
          per_page: 100,
          page,
          sort: 'updated',      // most recently updated first
          affiliation: 'owner', // only repos you own
        }
      });

      allRepos = allRepos.concat(response.data);

      // If less than 100 results, no more pages
      if (response.data.length < 100) break;
      page++;
    }

    // Return clean data to frontend
    const repos = allRepos.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      language: repo.language,
      updated_at: repo.updated_at,
      html_url: repo.html_url,
      default_branch: repo.default_branch,
    }));

    res.json({ repos, user: req.session.user });

  } catch (err) {
    console.error('Repos error:', err.message);
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});

// Get current logged in user
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SecureScan running at http://localhost:${PORT}`);
});
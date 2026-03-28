const params = new URLSearchParams(window.location.search);
const repoFullName = params.get('repo');
if (!repoFullName) window.location = '/repos.html';

const [owner, repo] = repoFullName.split('/');
let scanResult = null;
let scanProgress = 0;
let nistReasons = {};

document.getElementById('nav-repo').textContent = repoFullName;
document.getElementById('page-title').textContent = `Scanning ${repoFullName}...`;

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderMarkdown(text = '') {
  return DOMPurify.sanitize(marked.parse(String(text || '')), { USE_PROFILES: { html: true } });
}

function safeText(text = '') { return escapeHtml(String(text || '')); }

fetch('/api/me').then(r => r.json()).then(data => {
  if (data.user) {
    document.getElementById('nav-avatar').src = data.user.avatar_url;
    document.getElementById('nav-username').textContent = data.user.login;
  }
}).catch(() => {});

function updateProgress(msg) {
  document.getElementById('scan-status').textContent = msg;
  const log = document.getElementById('scan-log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  scanProgress = Math.min(scanProgress + 10, 90);
  document.getElementById('progress-bar').style.width = scanProgress + '%';
}

function startScan(isRescan = false) {
  document.getElementById('scanning-screen').style.display = 'block';
  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('error-screen').style.display = 'none';
  document.getElementById('btn-rescan').disabled = true;
  document.getElementById('scan-log').innerHTML = '';
  document.getElementById('page-title').textContent = isRescan
    ? `Rescanning ${repoFullName}...` : `Scanning ${repoFullName}...`;

  scanProgress = 5;
  document.getElementById('progress-bar').style.width = '5%';

  const url = `/api/scan/stream/${owner}/${repo}${isRescan ? '?rescan=true' : ''}`;
  const evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'status') updateProgress(data);
    if (type === 'questions') {
      evtSource.close();
      scanProgress = 100;
      document.getElementById('progress-bar').style.width = '100%';
      document.getElementById('scan-status').textContent = 'Scan complete! Loading questions...';
      sessionStorage.setItem('scan_questions_' + repoFullName, JSON.stringify(data.questions));
      setTimeout(() => { window.location = `/questions.html?repo=${encodeURIComponent(repoFullName)}`; }, 800);
    }
    if (type === 'done') {
      evtSource.close();
      scanProgress = 100;
      document.getElementById('progress-bar').style.width = '100%';
      document.getElementById('scan-status').textContent = 'Scan complete!';
      setTimeout(() => renderDashboard(data), 600);
    }
    if (type === 'error') { evtSource.close(); showError(data); }
  };

  evtSource.onerror = () => {
    evtSource.close();
    showError('Connection to server lost. Make sure the server is running.');
  };
}

function showError(msg) {
  document.getElementById('scanning-screen').style.display = 'none';
  document.getElementById('error-screen').style.display = 'block';
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('btn-rescan').disabled = false;
}

const nistMeta = {
  identify: { abbr: 'I', desc: 'Know your assets & risks' },
  protect:  { abbr: 'P', desc: 'Defend with access controls & encryption' },
  detect:   { abbr: 'D', desc: 'Monitor & catch threats early' },
  respond:  { abbr: 'R', desc: 'Act fast when incidents happen' },
  recover:  { abbr: 'R', desc: 'Restore systems after an attack' },
};

const gradeToPercent = { A: 92, B: 78, C: 58, D: 35, F: 12 };

function renderDashboard(result) {
  scanResult = result;

  document.getElementById('scanning-screen').style.display = 'none';
  document.getElementById('dashboard-screen').style.display = 'block';
  document.getElementById('btn-rescan').disabled = false;
  document.getElementById('page-title').textContent = `Risk Assessment — ${repoFullName}`;
  document.getElementById('scan-time').textContent =
    `Scanned just now · ${result.vulnerabilities?.length || 0} issues found`;

  const score = result.overall_score || 0;
  const scoreEl = document.getElementById('score-num');
  const badgeEl = document.getElementById('score-badge');
  scoreEl.textContent = score;

  const riskLevel = result.risk_level || 'HIGH';
  const colorMap = { CRITICAL:'#b91c1c', HIGH:'#dc2626', MEDIUM:'#d97706', LOW:'#16a34a' };
  const bgMap = {
    CRITICAL:'rgba(185,28,28,0.1)', HIGH:'rgba(220,38,38,0.1)',
    MEDIUM:'rgba(217,119,6,0.1)', LOW:'rgba(22,163,74,0.1)'
  };

  scoreEl.style.color = colorMap[riskLevel] || '#dc2626';
  badgeEl.textContent = riskLevel + ' RISK';
  badgeEl.style.color = colorMap[riskLevel];
  badgeEl.style.borderColor = colorMap[riskLevel];
  badgeEl.style.background = bgMap[riskLevel];

  document.getElementById('score-about-text').textContent = result.app_description || result.summary || '';
  document.getElementById('score-summary').textContent = result.summary || '';

  const nistGrid = document.getElementById('nist-grid');
  const nist = result.nist_scores || {};
  nistReasons = result.nist_reasons || {};
  const categories = ['identify', 'protect', 'detect', 'respond', 'recover'];

  nistGrid.innerHTML = categories.map(cat => {
    const grade = (nist[cat] || 'C').toUpperCase();
    const gradeClass = { A:'grade-a', B:'grade-b', C:'grade-c', D:'grade-d', F:'grade-f' }[grade] || 'grade-c';
    const barClass   = { A:'bar-a',   B:'bar-b',   C:'bar-c',   D:'bar-d',   F:'bar-f'  }[grade] || 'bar-c';
    const pct  = gradeToPercent[grade] || 50;
    const meta = nistMeta[cat];
    return `
      <div class="nist-item" onclick="toggleNistReason('${cat}')">
        <div class="nist-letter ${gradeClass}">${safeText(grade)}</div>
        <div class="nist-abbr">${safeText(meta.abbr)}</div>
        <div class="nist-bar-wrap"><div class="nist-bar-fill ${barClass}" style="width:${pct}%"></div></div>
        <div class="nist-pct">${pct}%</div>
        <div class="nist-desc-text">${safeText(meta.desc)}</div>
      </div>`;
  }).join('');

  const vulns = Array.isArray(result.vulnerabilities) ? [...result.vulnerabilities] : [];
  const sevOrder = { CRITICAL:0, HIGH:1, MEDIUM:2, LOW:3 };
  vulns.sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));

  const critCount = vulns.filter(v => (v.severity||'').toUpperCase() === 'CRITICAL').length;
  document.getElementById('vuln-count').textContent =
    `${vulns.length} issues${critCount > 0 ? ` · ${critCount} critical` : ''}`;

  document.getElementById('vuln-list').innerHTML = vulns.map((v, i) => {
    const sev = (v.severity || 'LOW').toUpperCase();
    const dotClass   = { CRITICAL:'dot-critical', HIGH:'dot-high', MEDIUM:'dot-medium', LOW:'dot-low' }[sev] || 'dot-low';
    const badgeClass = { CRITICAL:'sb-critical',  HIGH:'sb-high',  MEDIUM:'sb-medium',  LOW:'sb-low'  }[sev] || 'sb-low';
    const nistCategory = v.nist_category
      ? v.nist_category.charAt(0).toUpperCase() + v.nist_category.slice(1) : '';
    return `
      <div class="vuln-item" onclick="toggleVuln(${i})">
        <div class="sev-dot ${dotClass}"></div>
        <div style="flex:1">
          <div class="vuln-title">${safeText(v.title || 'Untitled issue')}</div>
          <div class="vuln-meta">
            <span class="vuln-file">${safeText(v.file || '')}</span>
            <span>${safeText(nistCategory)}</span>
          </div>
        </div>
        <span class="sev-badge ${badgeClass}">${safeText(sev)}</span>
      </div>
      <div class="vuln-detail" id="vuln-detail-${i}">
        <p>${safeText(v.description || '')}</p>
        ${v.fix ? `<div class="fix-box"><strong>How to fix:</strong>${safeText(v.fix)}</div>` : ''}
      </div>`;
  }).join('');

  const recs = Array.isArray(result.recommendations) ? result.recommendations : [];
  document.getElementById('rec-list').innerHTML = recs.map((r, i) => `
    <div class="rec-item">
      <div class="rec-num">${safeText(r.priority || i + 1)}</div>
      <div>
        <div class="rec-text">${safeText(r.action || '')}</div>
        <div class="rec-tag">${safeText(r.reason || '')}</div>
      </div>
    </div>`).join('');

  document.getElementById('chat-intro').innerHTML = renderMarkdown(
    `I've analyzed **${repoFullName}**. ${result.summary || ''} Ask me anything about these findings or how to fix them.`
  );
}

function toggleVuln(i) {
  const el = document.getElementById(`vuln-detail-${i}`);
  if (el) el.classList.toggle('open');
}

let activeNistCat = null;

function toggleNistReason(cat) {
  const box = document.getElementById('nist-reason-box');
  const prevActive = document.querySelector('.nist-item.active');
  if (prevActive) prevActive.classList.remove('active');

  if (activeNistCat === cat) {
    box.classList.remove('open');
    activeNistCat = null;
    return;
  }

  const reason = nistReasons[cat];
  if (!reason) return;

  box.textContent = reason;
  box.classList.add('open');
  document.querySelector(`[onclick="toggleNistReason('${cat}')"]`).classList.add('active');
  activeNistCat = cat;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !scanResult) return;

  input.value = '';
  document.getElementById('chat-send').disabled = true;
  appendChat('user', msg);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg,
        repo: repoFullName,
        context: {
          summary: scanResult.summary,
          vulnerabilities: scanResult.vulnerabilities,
          recommendations: scanResult.recommendations,
        }
      })
    });
    const data = await res.json();
    appendChat('ai', data.reply || 'Sorry, could not get a response.');
  } catch {
    appendChat('ai', 'Failed to get response. Check that the server is running.');
  }

  document.getElementById('chat-send').disabled = false;
  input.focus();
}

function appendChat(role, text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const who = role === 'ai' ? 'SecureScan AI' : 'You';
  const bubbleContent = role === 'ai' ? renderMarkdown(text) : safeText(text);
  div.innerHTML = `<div class="chat-who">${who}</div><div class="bubble">${bubbleContent}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

const isReady = params.get('ready');
if (isReady === 'true') {
  const stored = sessionStorage.getItem('scan_result_' + repoFullName);
  if (stored) {
    document.getElementById('scanning-screen').style.display = 'none';
    renderDashboard(JSON.parse(stored));
  } else {
    startScan();
  }
} else {
  startScan();
}

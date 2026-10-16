// MedReform Data Layer

const STORE_KEY    = 'medreform_ideas_v2';
const VOTED_KEY    = 'medreform_voted_v2';
const ADMIN_KEY    = 'medreform_admin_v2';
const FLAGS_KEY    = 'medreform_flags_v2';
const LOCKOUT_KEY  = 'medreform_lockout_v2';
const RATELIM_KEY  = 'medreform_ratelim_v2';
const AUDIT_KEY    = 'medreform_audit_v2';

const AUDIT_MAX_ENTRIES = 200;

// SHA-256 of 'MedReform2025' — change this hash to change the admin password.
// To generate a new hash: open browser console and run:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YourNewPassword'))
//     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
const ADMIN_PASSWORD_HASH = '30d95f288556c66967d1a018a81b85e3a93c382737c392714c8407226b8048c2';

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS  = 15 * 60 * 1000; // 15 minutes

const RATE_LIMIT_SUBMISSIONS_PER_HOUR = 3;
const RATE_LIMIT_COMMENTS_PER_HOUR    = 10;

// ─── Migration ───────────────────────────────────────────────────────────────

function migrateIdeas(oldIdeas) {
  const now = Date.now();
  return oldIdeas.map((idea, idx) => ({
    ...idea,
    submittedAt: now - (idx * 24 * 60 * 60 * 1000),
    flagCount: 0,
    flagged: false,
    comments: (idea.comments || []).map(c => ({
      ...c,
      submittedAt: now - (24 * 60 * 60 * 1000)
    }))
  }));
}

const SEED_IDEAS = [
  { id:1, votes:47, category:'infrastructure', title:'Outsource hostel and campus facility management to a private contractor', text:'The administration is not equipped to run facilities. Outsourcing hostel maintenance, groundskeeping, and pest control to a professional FM company removes this from the medical college\'s plate entirely. NMC doesn\'t prohibit this. Cost can be built into hostel fees.', author:'Anonymous Resident', role:'PG Resident', submittedAt: Date.now() - 3*24*60*60*1000, feasibility:78, status:'submitted', comments:[{text:'This would be transformative.',author:'You',submittedAt:Date.now()-2*24*60*60*1000}], flagCount:0, flagged:false },
  { id:2, votes:38, category:'governance',     title:'Mandatory HoD rotation every 3 years with performance review', text:'Several department heads have held their chairs for 8–12 years. Stale leadership = stale departments. Institute a formal rotation policy tied to CBME and research output benchmarks. AIIMS Delhi does this. We should too.', author:'Junior Faculty', role:'Junior Faculty', submittedAt: Date.now() - 5*24*60*60*1000, feasibility:45, status:'reviewed', comments:[], flagCount:0, flagged:false },
  { id:3, votes:31, category:'safety',         title:'Emergency snake response protocol + habitat removal drive', text:'This is a physical safety issue that has persisted for years. Immediate fix: empanel a professional pest control/wildlife service. Medium term: clear overgrown vegetation in a 100m radius around hostels. This costs less than ₹2L and could be done in a week.', author:'3rd Year Student', role:'MBBS Student (Clinical)', submittedAt: Date.now() - 7*24*60*60*1000, feasibility:90, status:'implemented', comments:[], flagCount:0, flagged:false },
  { id:4, votes:24, category:'governance',     title:'Digital grievance portal with mandatory 14-day resolution SLA', text:'Current system: complain to warden → warden files report → nothing. Proposed: an online portal where complaints are timestamped, assigned to a named responsible officer, and tracked publicly. No new budget needed — just implementation.', author:'Anonymous Student', role:'MBBS Student (Phase II)', submittedAt: Date.now() - 7*24*60*60*1000, feasibility:62, status:'submitted', comments:[], flagCount:0, flagged:false },
  { id:5, votes:18, category:'academic',       title:'Quarterly guest lecture series from AIIMS Kalyani faculty', text:'AIIMS Kalyani is 10 minutes away. A formal MoU for quarterly joint seminars would cost almost nothing but dramatically update clinical exposure. This is a massive underutilized proximity advantage.', author:'Senior Faculty', role:'Senior Faculty', submittedAt: Date.now() - 14*24*60*60*1000, feasibility:70, status:'submitted', comments:[], flagCount:0, flagged:false },
  { id:6, votes:12, category:'infrastructure', title:'Decentralize minor maintenance budgets to department level', text:'Departments currently wait months for a ₹5000 repair because everything routes through central admin. Give each department a small discretionary maintenance budget for non-capital items. Faster turnaround, less bottleneck.', author:'Anonymous Faculty', role:'Junior Faculty', submittedAt: Date.now() - 14*24*60*60*1000, feasibility:55, status:'rejected', comments:[], flagCount:0, flagged:false },
  { id:7, votes:8,  category:'governance',     title:'Student representation on college academic committee', text:'No state college in WB has formal student reps on the academic committee. One elected student from each batch, non-voting observer status, to surface ground realities the administration systematically fails to hear.', author:'Anonymous', role:'MBBS Student (Clinical)', submittedAt: Date.now() - 21*24*60*60*1000, feasibility:38, status:'submitted', comments:[], flagCount:0, flagged:false },
];

// ─── Crypto helpers ───────────────────────────────────────────────────────────

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ─── Brute-force lockout ──────────────────────────────────────────────────────

function getLockout() {
  try {
    return JSON.parse(localStorage.getItem(LOCKOUT_KEY) || '{"attempts":0,"lockedUntil":0}');
  } catch (e) { return { attempts: 0, lockedUntil: 0 }; }
}

function saveLockout(data) {
  try { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(data)); } catch (e) {}
}

function isLockedOut() {
  const l = getLockout();
  return l.lockedUntil > Date.now();
}

function lockoutRemainingMs() {
  return Math.max(0, getLockout().lockedUntil - Date.now());
}

function recordFailedAttempt() {
  const l = getLockout();
  l.attempts = (l.attempts || 0) + 1;
  if (l.attempts >= LOCKOUT_MAX_ATTEMPTS) {
    l.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    l.attempts = 0;
  }
  saveLockout(l);
}

function clearLockout() {
  saveLockout({ attempts: 0, lockedUntil: 0 });
}

// ─── Admin auth ───────────────────────────────────────────────────────────────

function getAdminSession() {
  try {
    const raw = localStorage.getItem(ADMIN_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session.expiresAt && Date.now() > session.expiresAt) {
      localStorage.removeItem(ADMIN_KEY);
      return null;
    }
    return session;
  } catch (e) { return null; }
}

async function setAdminSession(password) {
  if (isLockedOut()) return false;
  const hash = await sha256hex(password);
  if (hash !== ADMIN_PASSWORD_HASH) {
    recordFailedAttempt();
    return false;
  }
  clearLockout();
  try {
    const session = { authenticated: true, loginTime: Date.now(), expiresAt: Date.now() + 8*60*60*1000 };
    localStorage.setItem(ADMIN_KEY, JSON.stringify(session));
    return true;
  } catch (e) { return false; }
}

function clearAdminSession() {
  localStorage.removeItem(ADMIN_KEY);
}

function isAdminLoggedIn() {
  return getAdminSession() !== null;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

function getRateLimits() {
  try {
    return JSON.parse(localStorage.getItem(RATELIM_KEY) || '{"submissions":[],"comments":[]}');
  } catch (e) { return { submissions: [], comments: [] }; }
}

function saveRateLimits(data) {
  try { localStorage.setItem(RATELIM_KEY, JSON.stringify(data)); } catch (e) {}
}

function pruneOlderThanHour(timestamps) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return timestamps.filter(t => t > cutoff);
}

function canSubmitIdea() {
  const rl = getRateLimits();
  rl.submissions = pruneOlderThanHour(rl.submissions);
  saveRateLimits(rl);
  return rl.submissions.length < RATE_LIMIT_SUBMISSIONS_PER_HOUR;
}

function recordIdeaSubmission() {
  const rl = getRateLimits();
  rl.submissions = pruneOlderThanHour(rl.submissions);
  rl.submissions.push(Date.now());
  saveRateLimits(rl);
}

function canPostComment() {
  const rl = getRateLimits();
  rl.comments = pruneOlderThanHour(rl.comments);
  saveRateLimits(rl);
  return rl.comments.length < RATE_LIMIT_COMMENTS_PER_HOUR;
}

function recordCommentPost() {
  const rl = getRateLimits();
  rl.comments = pruneOlderThanHour(rl.comments);
  rl.comments.push(Date.now());
  saveRateLimits(rl);
}

// ─── Data retrieval ───────────────────────────────────────────────────────────

function getIdeas() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length) return p;
    }
  } catch (e) { console.error('Failed to load ideas:', e); }
  return SEED_IDEAS.map(i => JSON.parse(JSON.stringify(i)));
}

function saveIdeas(ideas) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ideas));
  } catch (e) {
    console.error('Failed to save ideas:', e);
    showToast('Storage full. Changes may not save.', '⚠️');
  }
}

function getVoted() {
  try {
    const raw = localStorage.getItem(VOTED_KEY);
    return new Set(JSON.parse(raw || '[]'));
  } catch (e) { return new Set(); }
}

function saveVoted(set) {
  try {
    localStorage.setItem(VOTED_KEY, JSON.stringify([...set]));
  } catch (e) { console.error('Failed to save votes:', e); }
}

// ─── Flags / spam detection ───────────────────────────────────────────────────

function getFlags() {
  try {
    const raw = localStorage.getItem(FLAGS_KEY);
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}

function saveFlags(flags) {
  try {
    localStorage.setItem(FLAGS_KEY, JSON.stringify(flags));
  } catch (e) { console.error('Failed to save flags:', e); }
}

function flagIdea(ideas, ideaId, reason) {
  const safeReason = String(reason).substring(0, 50);
  const flags = getFlags();
  const key = `idea_${ideaId}`;
  if (!flags[key]) flags[key] = [];
  flags[key].push({ reason: safeReason, timestamp: Date.now() });
  saveFlags(flags);
  const idea = ideas.find(i => i.id === ideaId);
  if (idea) {
    idea.flagCount = (idea.flagCount || 0) + 1;
    if (idea.flagCount >= 3) idea.flagged = true;
  }
}

function unflagIdea(ideas, ideaId) {
  const flags = getFlags();
  delete flags[`idea_${ideaId}`];
  saveFlags(flags);
  const idea = ideas.find(i => i.id === ideaId);
  if (idea) { idea.flagCount = 0; idea.flagged = false; }
}

// ─── Sanitization & escaping ──────────────────────────────────────────────────

// Escapes HTML for safe insertion into the DOM. Always call at render time.
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Trims and length-limits user input before storage. Does NOT HTML-encode
// so that raw text is stored and escHtml is applied only at render time.
function sanitizeText(s, maxLen) {
  return String(s).trim().substring(0, maxLen);
}

// ─── Formatting & display ─────────────────────────────────────────────────────

function formatTime(timestamp) {
  if (typeof timestamp !== 'number') return 'unknown';
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  const weeks   = Math.floor(days / 7);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours   < 24) return `${hours}h ago`;
  if (days    < 7)  return `${days}d ago`;
  if (weeks   < 4)  return `${weeks}w ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusLabel(status) {
  const labels = { submitted: 'Submitted', reviewed: 'Under Review', implemented: 'Implemented', rejected: 'Not Viable' };
  return labels[status] || status;
}

function statusColorBg(status) {
  const colors = { submitted: 'rgba(251,191,36,0.12)', reviewed: 'rgba(96,165,250,0.12)', implemented: 'rgba(237,119,171,0.12)', rejected: 'rgba(248,113,113,0.12)' };
  return colors[status] || 'rgba(95,99,104,0.12)';
}

function statusColor(status) {
  if (status === 'implemented') return 'var(--accent)';
  if (status === 'reviewed')    return 'var(--blue)';
  if (status === 'rejected')    return 'var(--red)';
  return 'var(--amber)';
}

function feasColor(f) {
  return f > 70 ? 'var(--accent)' : f > 40 ? 'var(--amber)' : 'var(--red)';
}

// ─── Search & filtering ───────────────────────────────────────────────────────

function searchIdeas(ideas, query) {
  if (!query || !query.trim()) return ideas;
  const q = query.toLowerCase();
  return ideas.filter(i =>
    i.title.toLowerCase().includes(q) ||
    i.text.toLowerCase().includes(q) ||
    i.author.toLowerCase().includes(q) ||
    i.role.toLowerCase().includes(q)
  );
}

function findSimilarIdeas(ideas, newTitle, newText, excludeId) {
  const titleWords = newTitle.toLowerCase().split(/\s+/);
  const textWords  = newText.toLowerCase().split(/\s+/);
  const searchWords = new Set([...titleWords, ...textWords].filter(w => w.length > 3));

  return ideas
    .filter(i => i.id !== excludeId)
    .map(idea => {
      const ideaWords = new Set((idea.title + ' ' + idea.text).toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const overlap = [...searchWords].filter(w => ideaWords.has(w)).length;
      const similarity = overlap / Math.max(searchWords.size, 1);
      return { idea, similarity };
    })
    .filter(({ similarity }) => similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .map(({ idea }) => idea);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function totalVotes(ideas) {
  return ideas.reduce((s, i) => s + i.votes, 0);
}

// ─── UI notifications ─────────────────────────────────────────────────────────

function showToast(msg, icon) {
  const t = document.getElementById('toast');
  if (!t) return;
  const toastText = t.querySelector('.toast-text');
  const toastIcon = t.querySelector('.toast-icon');
  if (toastText) toastText.textContent = msg;
  if (toastIcon) toastIcon.textContent = icon || '✓';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ─── Comments management ──────────────────────────────────────────────────────

function addComment(ideas, ideaId, text, author) {
  const idea = ideas.find(i => i.id === ideaId);
  if (!idea) return false;
  const comment = {
    text:        sanitizeText(text, 500),
    author:      sanitizeText(author || 'You', 100),
    submittedAt: Date.now()
  };
  idea.comments.push(comment);
  return true;
}

function getComments(ideas, ideaId) {
  const idea = ideas.find(i => i.id === ideaId);
  return idea ? (idea.comments || []) : [];
}

function deleteComment(ideas, ideaId, commentIndex) {
  const idea = ideas.find(i => i.id === ideaId);
  if (idea && idea.comments[commentIndex]) {
    idea.comments.splice(commentIndex, 1);
    return true;
  }
  return false;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

function getAuditLog() {
  try { return JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]'); } catch (e) { return []; }
}

function addAuditEntry(action, detail) {
  try {
    const log = getAuditLog();
    log.unshift({ action, detail: String(detail).substring(0, 200), timestamp: Date.now() });
    if (log.length > AUDIT_MAX_ENTRIES) log.splice(AUDIT_MAX_ENTRIES);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(log));
  } catch (e) {}
}

function clearAuditLog() {
  localStorage.removeItem(AUDIT_KEY);
}

// ─── Idea operations ──────────────────────────────────────────────────────────

function createIdea(data) {
  const ideas  = getIdeas();
  const maxId  = Math.max(0, ...ideas.map(i => i.id));
  const newIdea = {
    id:          maxId + 1,
    votes:       0,
    category:    data.category || 'governance',
    title:       sanitizeText(data.title, 150),
    text:        sanitizeText(data.text, 1000),
    author:      data.anonymous ? 'Anonymous' : sanitizeText(data.author || 'Anonymous', 100),
    role:        sanitizeText(data.role || 'Other', 50),
    submittedAt: Date.now(),
    feasibility: parseInt(data.feasibility) || 50,
    status:      'submitted',
    comments:    [],
    flagCount:   0,
    flagged:     false
  };
  ideas.push(newIdea);
  saveIdeas(ideas);
  return newIdea;
}

function updateIdea(ideas, ideaId, fields) {
  const idea = ideas.find(i => i.id === ideaId);
  if (!idea) return false;
  const allowed = ['title', 'text', 'category', 'feasibility', 'status', 'author', 'role'];
  const validStatuses = ['submitted', 'reviewed', 'implemented', 'rejected'];
  const validCategories = ['governance', 'safety', 'academic', 'infrastructure', 'welfare'];
  allowed.forEach(key => {
    if (!(key in fields)) return;
    if (key === 'status'      && !validStatuses.includes(fields[key]))   return;
    if (key === 'category'    && !validCategories.includes(fields[key]))  return;
    if (key === 'feasibility') { idea[key] = Math.min(100, Math.max(0, parseInt(fields[key]) || 0)); return; }
    if (['title','text','author','role'].includes(key)) { idea[key] = sanitizeText(fields[key], key === 'text' ? 1000 : 150); return; }
    idea[key] = fields[key];
  });
  return true;
}

function updateIdeaStatus(ideas, ideaId, newStatus) {
  const idea = ideas.find(i => i.id === ideaId);
  if (idea && ['submitted', 'reviewed', 'implemented', 'rejected'].includes(newStatus)) {
    idea.status = newStatus;
    return true;
  }
  return false;
}

function deleteIdea(ideas, ideaId) {
  const index = ideas.findIndex(i => i.id === ideaId);
  if (index !== -1) {
    ideas.splice(index, 1);
    return true;
  }
  return false;
}

function exportData(ideas) {
  const data = { exportedAt: new Date().toISOString(), totalIdeas: ideas.length, totalVotes: totalVotes(ideas), ideas };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `medreform-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

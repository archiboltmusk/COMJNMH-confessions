/* Blood donor list for donors.html. Donors join on purpose; anyone can search by blood group and area.
   Phone and email come back only for donors who chose to show them. A donor manages their entry with a code shown once at sign-up.
   Data: Supabase table blood_donors (supabase/migrations/20261016200000_blood_donors.sql), read and written only through RPCs. */
(function () {
  'use strict';

  // Public project URL and anon key of the "confessions" Supabase project. Safe to ship: row rules do the limiting.
  var SUPABASE_URL = 'https://btkkofaeksuyupajsigj.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0a2tvZmFla3N1eXVwYWpzaWdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzk5ODYsImV4cCI6MjEwNzcxNTk4Nn0.qLCtq3fqid-WQcYp6AMAVH_AxT7w6PJeXIJ4XFUgG34';
  var CODE_KEY = 'medreform_donor_code';
  var GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  var PHONE_RE = /^\+?[0-9]{10,13}$/;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var say = function (el, msg, bad) {
    el.textContent = msg || '';
    el.className = 'dn-msg' + (bad ? ' bad' : '');
  };

  var sb = null;
  try {
    sb = window.supabase && window.supabase.createClient
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;
  } catch (e) { sb = null; }

  var storedCode = function () {
    try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; }
  };
  var saveCode = function (code) {
    try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* private window: the code is still shown once */ }
  };

  // Search ---------------------------------------------------------------

  function renderDonors(rows) {
    var box = $('dn-results');
    if (!rows.length) {
      box.innerHTML = '<p class="dn-empty">No donors match yet. Try any blood group, or join below.</p>';
      return;
    }
    box.innerHTML = rows.map(function (r) {
      var contact = '';
      if (r.show_contact) {
        var parts = [];
        if (r.phone) parts.push('<a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a>');
        if (r.email) parts.push('<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>');
        contact = '<div class="dn-meta dn-contact">' + parts.join(' · ') + '</div>';
      } else {
        contact = '<div class="dn-hidden">Contact hidden: this donor has not chosen to show it.</div>';
      }
      return '<article class="dn-item">' +
        '<div><strong>' + esc(r.name) + '</strong><div class="dn-meta">' + esc(r.area) + '</div>' + contact + '</div>' +
        '<span class="dn-group">' + esc(r.blood_group) + '</span>' +
        '</article>';
    }).join('');
  }

  async function search(e) {
    if (e) e.preventDefault();
    var status = $('dn-status');
    if (!sb) { say(status, 'Donor list is not on yet. Please try again later.', true); return; }
    var group = $('dn-group').value;
    var area = $('dn-area').value.trim();
    say(status, 'Searching…');
    var res = await sb.rpc('blood_donor_search', { p_blood_group: group || null, p_area: area || null });
    if (res.error) { say(status, 'Could not load donors right now. Please try again.', true); return; }
    var rows = res.data || [];
    $('dn-count').textContent = '(' + rows.length + ')';
    say(status, '');
    renderDonors(rows);
  }

  // Join -----------------------------------------------------------------

  function readJoin() {
    return {
      name: $('dn-name').value.trim(),
      blood_group: $('dn-join-group').value,
      area: $('dn-join-area').value.trim(),
      phone: $('dn-phone').value.replace(/[\s()-]/g, ''),
      email: $('dn-email').value.trim(),
      show: $('dn-show').checked,
      consent: $('dn-consent').checked
    };
  }

  function checkJoin(v) {
    if (v.name.length < 2 || v.name.length > 80) return 'Please enter your name (2 to 80 characters).';
    if (GROUPS.indexOf(v.blood_group) < 0) return 'Please choose your blood group.';
    if (v.area.length < 2 || v.area.length > 80) return 'Please enter your area (2 to 80 characters).';
    if (!v.phone && !v.email) return 'Give a phone number or an email so searchers can reach you.';
    if (v.phone && !PHONE_RE.test(v.phone)) return 'Phone number looks wrong. Use 10 digits, with +91 if you like.';
    if (v.email && (v.email.length > 120 || !EMAIL_RE.test(v.email))) return 'Email address looks wrong.';
    if (!v.consent) return 'Please tick the age and donation check to join.';
    return '';
  }

  async function join(e) {
    e.preventDefault();
    var msg = $('dn-join-msg');
    var btn = $('dn-join-btn');
    if (!sb) { say(msg, 'Donor list is not on yet. Please try again later.', true); return; }
    var v = readJoin();
    var problem = checkJoin(v);
    if (problem) { say(msg, problem, true); return; }
    btn.disabled = true;
    say(msg, 'Saving…');
    var res = await sb.rpc('blood_donor_register', {
      p_name: v.name,
      p_blood_group: v.blood_group,
      p_area: v.area,
      p_phone: v.phone || null,
      p_email: v.email || null,
      p_show_contact: v.show,
      p_consent: v.consent
    });
    btn.disabled = false;
    if (res.error || !res.data) { say(msg, 'Could not save your entry. Please check the details and try again.', true); return; }
    saveCode(res.data);
    $('dn-code').textContent = res.data;
    $('dn-code-box').hidden = false;
    $('dn-code-input').value = res.data;
    $('dn-join').reset();
    say(msg, 'Thank you. You are on the donor list. Copy your code below: it is shown once.');
    search();
  }

  // Manage ---------------------------------------------------------------

  async function manage(kind) {
    var msg = $('dn-mine-msg');
    if (!sb) { say(msg, 'Donor list is not on yet. Please try again later.', true); return; }
    var code = $('dn-code-input').value.trim();
    if (!code) { say(msg, 'Paste the code you got when you joined.', true); return; }
    var res;
    if (kind === 'withdraw') {
      if (!window.confirm('Delete your entry from the donor list? This cannot be undone.')) return;
      res = await sb.rpc('blood_donor_withdraw', { p_token: code });
    } else {
      res = await sb.rpc('blood_donor_set_contact', { p_token: code, p_show: kind === 'show' });
    }
    if (res.error) { say(msg, 'Could not reach the donor list. Please try again.', true); return; }
    if (!res.data) { say(msg, 'No entry matches this code.', true); return; }
    if (kind === 'withdraw') {
      try { localStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ }
      $('dn-code-input').value = '';
      $('dn-code-box').hidden = true;
      say(msg, 'Your entry is deleted.');
    } else {
      say(msg, kind === 'show' ? 'Your phone and email are now shown to searchers.' : 'Your phone and email are now hidden.');
    }
    search();
  }

  // Start ----------------------------------------------------------------

  $('dn-search').addEventListener('submit', search);
  $('dn-join').addEventListener('submit', join);
  $('dn-show-on').addEventListener('click', function () { manage('show'); });
  $('dn-show-off').addEventListener('click', function () { manage('hide'); });
  $('dn-withdraw').addEventListener('click', function () { manage('withdraw'); });

  var code = storedCode();
  if (code) $('dn-code-input').value = code;
  search();
})();

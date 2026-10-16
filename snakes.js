/* Snake sightings for Kalyani. A live camera photo and GPS go in; the last 48 hours come out.
   No sign-in, and the sender is not stored. Data: Firestore collection snake_sightings (rules in snake-firestore.rules). */
(function () {
  'use strict';

  // Kalyani only. Centre of Kalyani town, Nadia; the radius is approximate, confirm before launch.
  var AREA = { name: 'Kalyani', lat: 22.9753, lng: 88.4433, radius_km: 8 };
  var MAX_ACCURACY_M = 100;
  var HOURS = 48;
  var MAX_NOTE = 140;
  var COOLDOWN_MS = 10 * 60 * 1000;          // per device only; anonymous posts have no account to limit
  var COOLDOWN_KEY = 'medreform_snake_last_sent';
  var PHOTO_PREFIX = 'data:image/jpeg;base64,';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var say = function (msg, bad) {
    var el = $('sn-msg');
    el.textContent = msg;
    el.className = 'sn-msg' + (bad ? ' bad' : '');
  };

  function distanceKm(lat1, lng1, lat2, lng2) {
    var R = 6371, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function inArea(lat, lng) { return distanceKm(AREA.lat, AREA.lng, lat, lng) <= AREA.radius_km; }
  function round3(n) { return Math.round(n * 1000) / 1000; }

  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  // Firebase is set up in firebase-backend.js (global `db`). Until its config is filled in, there is no store.
  function store() {
    try { return typeof db !== 'undefined' && db ? db : null; } catch (e) { return null; }
  }

  var stream = null;
  var shot = null;

  function stopCamera() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function reset() {
    shot = null;
    stopCamera();
    $('sn-video').hidden = true;
    $('sn-shoot').hidden = true;
    $('sn-preview').hidden = true;
    $('sn-retake').hidden = true;
    $('sn-note').hidden = true;
    $('sn-send').hidden = true;
    $('sn-note').value = '';
    $('sn-cam').hidden = false;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('This browser has no camera access. Open the page in Chrome or Safari over https.', true);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      $('sn-video').srcObject = stream;
      $('sn-video').hidden = false;
      $('sn-shoot').hidden = false;
      $('sn-cam').hidden = true;
      say('Stand back, point the camera at the snake, then take the photo.');
    } catch (e) {
      say('Camera access was refused. Allow the camera for this site and try again.', true);
    }
  }

  function shoot() {
    var v = $('sn-video');
    if (!v.videoWidth) { say('The camera is not ready yet. Wait a second and try again.', true); return null; }
    var scale = Math.min(1, 720 / v.videoWidth);
    var c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  }

  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('This phone has no location access.'));
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve(p.coords); },
        function () { reject(new Error('Location was refused. Allow location for this site and try again.')); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  async function send() {
    var note = $('sn-note').value.trim().replace(/\s+/g, ' ');
    if (note.length > MAX_NOTE) return say('Keep the note to ' + MAX_NOTE + ' characters.', true);
    if (!shot) return say('Take the photo first.', true);
    var last = 0;
    try { last = Number(localStorage.getItem(COOLDOWN_KEY) || 0); } catch (e) {}
    if (Date.now() - last < COOLDOWN_MS) return say('You sent one a moment ago. Wait a few minutes before the next.', true);
    var s = store();
    if (!s) return say('Snake reports are not switched on yet.', true);

    $('sn-send').disabled = true;
    say('Getting a precise location…');
    try {
      var c = await locate();
      if (c.accuracy > MAX_ACCURACY_M) {
        throw new Error('Your location is not precise enough yet (' + Math.round(c.accuracy) + ' m). Wait outdoors a moment and try again.');
      }
      if (!inArea(c.latitude, c.longitude)) throw new Error('Snake sightings are for ' + AREA.name + ' only.');
      say('Sending…');
      await s.collection('snake_sightings').add({
        photo: shot,
        lat: round3(c.latitude),
        lng: round3(c.longitude),
        accuracy_m: Math.round(c.accuracy),
        note: note || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        expireAt: firebase.firestore.Timestamp.fromMillis(Date.now() + HOURS * 3600 * 1000)
      });
      try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch (e) {}
      reset();
      say('Sent. Everyone in ' + AREA.name + ' can see it for 48 hours. Nobody sees who sent it.');
      load();
    } catch (e) {
      say(e.message || 'Could not send. Try again.', true);
    } finally {
      $('sn-send').disabled = false;
    }
  }

  async function load() {
    var s = store(), box = $('sn-list');
    if (!s) {
      $('sn-updated').textContent = 'Not switched on yet';
      box.innerHTML = '<p class="sn-empty">Sightings appear here once the site is connected to its database.</p>';
      return;
    }
    try {
      var snap = await s.collection('snake_sightings')
        .where('expireAt', '>', new Date()).orderBy('expireAt', 'desc').limit(50).get();
      var html = [];
      snap.forEach(function (d) {
        var r = d.data();
        if (!r.photo || r.photo.indexOf(PHOTO_PREFIX) !== 0) return;
        var t = r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : Date.now();
        html.push('<article class="sn-item"><img src="' + esc(r.photo) + '" alt="Snake photo from ' + esc(AREA.name) + '" loading="lazy">' +
          '<div><div class="sn-when">' + esc(ago(t)) + ' · ' + esc(AREA.name) + '</div>' +
          (r.note ? '<p>' + esc(r.note) + '</p>' : '') + '</div></article>');
      });
      box.innerHTML = html.length ? html.join('') :
        '<p class="sn-empty">No snake reported in ' + esc(AREA.name) + ' in the last 48 hours.</p>';
      $('sn-count').textContent = html.length ? '(' + html.length + ')' : '';
      $('sn-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      $('sn-updated').textContent = 'Could not load';
      box.innerHTML = '<p class="sn-empty">Could not load sightings. Try again later.</p>';
    }
  }

  $('sn-cam').addEventListener('click', startCamera);
  $('sn-shoot').addEventListener('click', function () {
    var data = shoot();
    if (!data) return;
    shot = data;
    stopCamera();
    $('sn-video').hidden = true;
    $('sn-shoot').hidden = true;
    $('sn-preview').src = data;
    $('sn-preview').hidden = false;
    $('sn-retake').hidden = false;
    $('sn-note').hidden = false;
    $('sn-send').hidden = false;
    say('Add a note if you like, then send.');
  });
  $('sn-retake').addEventListener('click', function () { reset(); startCamera(); });
  $('sn-send').addEventListener('click', send);
  window.addEventListener('pagehide', stopCamera);

  load();
})();

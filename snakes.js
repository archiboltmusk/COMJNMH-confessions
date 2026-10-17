/* Snake sightings for JNM Hospital, Kalyani. A live phone camera photo and GPS go in; the last 48 hours come out, as pins on the map and cards below.
   No sign-in, and the sender is not stored. Data: Supabase table snake_sightings (supabase/migrations/20261016170000_snake_sightings.sql, 20261016180000_snake_taken_away.sql, 20261016190000_snake_report_sighting.sql). */
(function () {
  'use strict';

  // Public project URL and anon key of the "confessions" Supabase project. Safe to ship: row rules do the limiting.
  var SUPABASE_URL = 'https://btkkofaeksuyupajsigj.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0a2tvZmFla3N1eXVwYWpzaWdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzk5ODYsImV4cCI6MjEwNzcxNTk4Nn0.qLCtq3fqid-WQcYp6AMAVH_AxT7w6PJeXIJ4XFUgG34';

  // JNM Hospital campus, Kalyani (College of Medicine & JNM Hospital; point from Wikipedia, rounded). Radius is approximate, confirm before launch.
  var AREA = { name: 'JNM Hospital', lat: 22.9744, lng: 88.4557, radius_km: 0.8 };
  var MAX_ACCURACY_M = 100;
  var AUTO_FIX_MS = 3 * 60 * 1000;          // a location taken when the photo is shot is reused for this long
  var MAX_NOTE = 140;
  var MAX_REPORTS = 3;                       // sightings with this many reports are hidden
  var COOLDOWN_MS = 10 * 60 * 1000;          // per device only; anonymous posts have no account to limit
  var COOLDOWN_KEY = 'medreform_snake_last_sent';
  var REPORTED_KEY = 'medreform_snake_reported';
  var PHOTO_PREFIX = 'data:image/jpeg;base64,';
  // Map: OpenStreetMap building footprints for the campus box.
  var MAP_BOX = { s: 22.965, w: 88.445, n: 22.985, e: 88.47 };
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

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

  // Phones only. Laptops and desktops are refused; the browser's own mobile flag is used where it exists.
  function isPhone() {
    if (navigator.userAgentData && navigator.userAgentData.mobile === false) return false;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
      (navigator.maxTouchPoints > 1 && /Mobi/i.test(navigator.userAgent || ''));
  }

  // Supabase client from the CDN script. Null if the script did not load.
  function store() {
    try {
      return window.supabase && window.supabase.createClient
        ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : null;
    } catch (e) { return null; }
  }

  var stream = null;
  var shot = null;
  var autoFix = null;   // { p: promise of coords, at: ms } taken when the photo was shot

  function stopCamera() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  // Camera stage: full screen while live, back to the page after the photo, Retake or Cancel.
  function setLive(on) {
    $('sn-stage').className = on ? 'live' : '';
    $('sn-video').hidden = !on;
    $('sn-shoot').hidden = !on;
    $('sn-cancel').hidden = !on;
  }

  function reset() {
    shot = null;
    autoFix = null;
    stopCamera();
    setLive(false);
    $('sn-preview').hidden = true;
    $('sn-retake').hidden = true;
    $('sn-note').hidden = true;
    $('sn-send').hidden = true;
    $('sn-note').value = '';
    $('sn-fix').textContent = '';
    $('sn-cam').hidden = false;
  }

  // Live camera only: getUserMedia, no file input and no gallery anywhere on the page.
  async function startCamera() {
    if (!isPhone()) {
      say('Sightings are sent from a phone camera only. Open this page on your phone.', true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('This browser has no camera access. Open the page in Chrome or Safari over https.', true);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      $('sn-video').srcObject = stream;
      setLive(true);
      $('sn-video').play().catch(function () {});
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
    return c;
  }

  // Face rule: refuse a photo with a face in it. Only where the browser has FaceDetector (Chrome on Android); elsewhere the Report button is the backstop.
  async function hasFace(canvas) {
    if (!window.FaceDetector) return false;
    try {
      var faces = await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }).detect(canvas);
      return faces.length > 0;
    } catch (e) { return false; }
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

  // Auto capture: start the location lookup as soon as the photo is taken.
  function startAutoFix() {
    var p = locate();
    p.catch(function () {});
    autoFix = { p: p, at: Date.now() };
    $('sn-fix').textContent = 'Finding your location…';
    p.then(function (c) {
      $('sn-fix').textContent = 'Location found, about ' + Math.round(c.accuracy) + ' m. It is sent with the photo.';
    }, function (e) {
      autoFix = null;
      $('sn-fix').textContent = e.message + ' It will be asked again when you send.';
    });
  }

  function getFix() {
    if (autoFix && Date.now() - autoFix.at < AUTO_FIX_MS) return autoFix.p;
    return locate();
  }

  async function send() {
    var note = $('sn-note').value.trim().replace(/\s+/g, ' ');
    if (note.length > MAX_NOTE) return say('Keep the note to ' + MAX_NOTE + ' characters.', true);
    if (!shot) return say('Take the photo first.', true);
    var last = 0;
    try { last = Number(localStorage.getItem(COOLDOWN_KEY) || 0); } catch (e) {}
    if (Date.now() - last < COOLDOWN_MS) return say('You sent one a moment ago. Wait a few minutes before the next.', true);
    var sb = store();
    if (!sb) return say('Snake reports are not switched on yet.', true);

    $('sn-send').disabled = true;
    say('Getting a precise location…');
    try {
      var c = await getFix();
      if (c.accuracy > MAX_ACCURACY_M) {
        throw new Error('Your location is not precise enough yet (' + Math.round(c.accuracy) + ' m). Wait outdoors a moment and try again.');
      }
      if (!inArea(c.latitude, c.longitude)) throw new Error('Snake sightings are only for ' + AREA.name + '.');
      say('Sending…');
      var res = await sb.from('snake_sightings').insert({
        photo: shot,
        lat: round3(c.latitude),
        lng: round3(c.longitude),
        accuracy_m: Math.round(c.accuracy),
        note: note || null
      });
      if (res.error) throw new Error('Could not send. Try again in a moment.');
      try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch (e) {}
      reset();
      say('Sent. Everyone at ' + AREA.name + ' can see it for 48 hours. Nobody sees who sent it.');
      load();
    } catch (e) {
      say(e.message || 'Could not send. Try again.', true);
    } finally {
      $('sn-send').disabled = false;
    }
  }

  function reportedIds() {
    try { return JSON.parse(localStorage.getItem(REPORTED_KEY) || '[]'); } catch (e) { return []; }
  }
  function rememberReport(id) {
    var ids = reportedIds();
    ids.push(id);
    try { localStorage.setItem(REPORTED_KEY, JSON.stringify(ids.slice(-200))); } catch (e) {}
  }

  // Someone saw the snake removed: hide it from the list and map.
  async function takenAway(btn) {
    var sb = store();
    if (!sb) return;
    btn.disabled = true;
    var res = await sb.rpc('snake_mark_taken', { p_id: Number(btn.getAttribute('data-id')) });
    if (res.error) {
      btn.disabled = false;
      return say('Could not mark it. Try again.', true);
    }
    say('Marked as taken away. It is hidden from the list and the map.');
    load();
  }

  // A joke, a person, or not a snake. Each device reports a sighting once.
  async function reportSighting(btn) {
    var sb = store();
    var id = btn.getAttribute('data-id');
    if (!sb || reportedIds().indexOf(id) >= 0) return;
    btn.disabled = true;
    var res = await sb.rpc('snake_report_sighting', { p_id: Number(id) });
    if (res.error) {
      btn.disabled = false;
      return say('Could not send the report. Try again.', true);
    }
    rememberReport(id);
    say('Thanks. A sighting with ' + MAX_REPORTS + ' reports is hidden.');
    load();
  }

  // Map: dark styling comes from snakes.html (CSS filter on the OSM tiles). Pins = sightings from load().
  var map = null, buildingLayer = null, pinLayer = null, pinColor = '#e0a84f';

  function initMap() {
    var box = $('sn-map');
    if (!box) return;
    if (!window.L) {
      $('sn-map-status').textContent = 'The map could not load. Check your connection and refresh.';
      return;
    }
    var css = getComputedStyle(document.documentElement);
    var accent = css.getPropertyValue('--accent').trim() || '#e0a84f';
    var dim = css.getPropertyValue('--text-dim').trim() || '#888';

    map = L.map(box, { scrollWheelZoom: false }).setView([AREA.lat, AREA.lng], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);
    buildingLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    pinColor = accent;

    var q = '[out:json][timeout:25];way["building"](' + MAP_BOX.s + ',' + MAP_BOX.w + ',' + MAP_BOX.n + ',' + MAP_BOX.e + ');out geom;';
    fetch(OVERPASS_URL + '?data=' + encodeURIComponent(q))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var n = 0;
        (j.elements || []).forEach(function (w) {
          if (!w.geometry || w.geometry.length < 3) return;
          var ring = w.geometry.map(function (p) { return [p.lat, p.lon]; });
          L.polygon(ring, { color: dim, weight: 0.6, fillColor: dim, fillOpacity: 0.45, interactive: false }).addTo(buildingLayer);
          n++;
        });
        $('sn-map-status').textContent = n + ' buildings from OpenStreetMap. Pins are sightings from the last 48 hours.';
      })
      .catch(function () {
        $('sn-map-status').textContent = 'Buildings could not load from OpenStreetMap right now. Sightings still show as pins.';
      });
  }

  function drawPins(pins) {
    if (!pinLayer) return;
    pinLayer.clearLayers();
    pins.forEach(function (p) {
      L.circleMarker([p.lat, p.lng], {
        radius: 7, color: '#fff', weight: 2, fillColor: pinColor, fillOpacity: 1
      }).bindPopup('<strong>Snake</strong><br>' + esc(ago(p.t)) + (p.note ? '<br>' + esc(p.note) : ''))
        .addTo(pinLayer);
    });
  }

  async function load() {
    var sb = store(), box = $('sn-list');
    if (!sb) {
      $('sn-updated').textContent = 'Not switched on yet';
      box.innerHTML = '<p class="sn-empty">Sightings appear here once the site is connected to its database.</p>';
      return;
    }
    try {
      var res = await sb.from('snake_sightings')
        .select('id, photo, note, lat, lng, created_at')
        .gt('expires_at', new Date().toISOString())
        .is('taken_away_at', null)
        .lt('report_count', MAX_REPORTS)
        .order('created_at', { ascending: false })
        .limit(50);
      if (res.error) throw res.error;
      var html = [], pins = [], mine = reportedIds();
      (res.data || []).forEach(function (r) {
        if (!r.photo || r.photo.indexOf(PHOTO_PREFIX) !== 0) return;
        var t = new Date(r.created_at).getTime();
        var id = String(r.id);
        var done = mine.indexOf(id) >= 0;
        if (typeof r.lat === 'number' && typeof r.lng === 'number') pins.push({ lat: r.lat, lng: r.lng, t: t, note: r.note });
        html.push('<article class="sn-item"><img src="' + esc(r.photo) + '" alt="Snake photo from ' + esc(AREA.name) + '" loading="lazy">' +
          '<div><div class="sn-when">' + esc(ago(t)) + ' · ' + esc(AREA.name) + '</div>' +
          (r.note ? '<p>' + esc(r.note) + '</p>' : '') +
          '<div class="sn-row"><button type="button" class="sn-btn ghost sn-taken" data-id="' + esc(id) + '">Snake taken away</button>' +
          '<button type="button" class="sn-btn ghost sn-report" data-id="' + esc(id) + '"' + (done ? ' disabled' : '') + '>' + (done ? 'Reported' : 'Report') + '</button></div></div></article>');
      });
      drawPins(pins);
      box.innerHTML = html.length ? html.join('') :
        '<p class="sn-empty">No snake reported at ' + esc(AREA.name) + ' in the last 48 hours.</p>';
      $('sn-count').textContent = html.length ? '(' + html.length + ')' : '';
      $('sn-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      $('sn-updated').textContent = 'Could not load';
      box.innerHTML = '<p class="sn-empty">Could not load sightings. Try again later.</p>';
    }
  }

  $('sn-cam').addEventListener('click', startCamera);
  $('sn-cancel').addEventListener('click', function () { reset(); say(''); });
  $('sn-shoot').addEventListener('click', async function () {
    var canvas = shoot();
    if (!canvas) return;
    if (await hasFace(canvas)) {
      return say('A face is in the photo. Retake it, pointing the camera at the snake and away from people.', true);
    }
    shot = canvas.toDataURL('image/jpeg', 0.6);
    stopCamera();
    setLive(false);
    $('sn-preview').src = shot;
    $('sn-preview').hidden = false;
    $('sn-retake').hidden = false;
    $('sn-note').hidden = false;
    $('sn-send').hidden = false;
    if ($('sn-auto').checked) startAutoFix();
    say('Check the photo, add a note if you like, then send.');
  });
  $('sn-retake').addEventListener('click', function () { reset(); startCamera(); });
  $('sn-send').addEventListener('click', send);
  $('sn-list').addEventListener('click', function (e) {
    var taken = e.target.closest ? e.target.closest('.sn-taken') : null;
    var report = e.target.closest ? e.target.closest('.sn-report') : null;
    if (taken) takenAway(taken);
    if (report) reportSighting(report);
  });
  window.addEventListener('pagehide', stopCamera);

  initMap();
  load();
})();

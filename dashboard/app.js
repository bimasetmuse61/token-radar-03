// Token Radar dashboard (radar-4): renders window.RADAR, written by main.ts, with
// no network. Board with scale-weighted peer value bands and evidence grades,
// filters (search, category, chain, evidence, watchlist-only), sorting (value, TVL,
// growth, age, band width, evidence, name), a detail view per protocol (value
// drivers, the weighted peers that priced it, farm plan with its budget) and a
// separate already-trading view priced at real market caps.
// View state can be deep-linked with query parameters or a hash, e.g.
// ?detail=<slug>, ?cat=<category>, ?chain=<chain>, ?ev=A, ?watch=1, ?live=1.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.textContent = 'Token Radar: no data loaded.'; return; }

  var $ = function (id) { return document.getElementById(id); };
  var rowsEl = $('rows'), countEl = $('count'), qEl = $('q'), catEl = $('cat'),
      chainEl = $('chain'), evEl = $('ev'), sortEl = $('sort'), watchEl = $('watch'),
      liveTEl = $('live-toggle'), detailEl = $('detail'), liveEl = $('live');

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(v) {
    if (v === null || v === undefined) return '—';
    return '<span class="' + (v >= 0 ? 'pos' : 'neg') + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function age(v) { return v === null || v === undefined ? '—' : (v >= 365 ? (v / 365).toFixed(1) + 'y' : v + 'd'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hours(min) { return min >= 90 ? (min / 60).toFixed(1).replace(/\.0$/, '') + ' h' : min + ' min'; }

  // One stable colour per category, picked by a hash of its name from an earthy
  // palette chosen for this page: the assignment is the same on every load.
  var PALETTE = ['#bc3f16', '#a87c14', '#1e7a4f', '#33566e', '#7a4a8c', '#8c5a2b', '#2b6e7a', '#96606e', '#5a7a2b', '#4a5a8c', '#b3352b', '#6e5622'];
  function chipColor(cat) {
    var h = 0, s = cat || '(none)';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function chip(cat) {
    if (!cat) return '<span class="chip">Uncategorised</span>';
    return '<span class="chip" style="--chipc:' + chipColor(cat) + '">' + esc(cat) + '</span>';
  }
  function evChip(g) { return '<span class="ev ev-' + g + '" title="Evidence grade ' + g + '">' + g + '</span>'; }

  $('asof').textContent = R.as_of;
  $('src-date').textContent = R.as_of;
  $('stat-rows').textContent = R.board_size;
  $('stat-watch').textContent = R.watchlist_size + ' / ' + R.watchlist_size;
  $('stat-early').textContent = R.early_size;
  $('stat-top').textContent = money(R.rows[0].implied_value_usd);
  $('stat-global').textContent = R.model.global_multiple.toFixed(3) + 'x · ' + R.model.global_peers + ' peers';

  // Fastest risers: the five board rows with the highest reported 7d TVL change.
  var movers = R.rows.filter(function (r) { return r.change_7d !== null; })
    .slice().sort(function (a, b) { return b.change_7d - a.change_7d; }).slice(0, 5);
  $('movers').innerHTML = movers.map(function (r) {
    return '<button type="button" class="mover" data-slug="' + esc(r.slug) + '">' + esc(r.name) +
      ' <b>' + (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%</b> · ' + money(r.implied_value_usd) + '</button>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.mover'), function (b) {
    b.addEventListener('click', function () { showDetail(b.getAttribute('data-slug')); });
  });

  var cats = [], chains = [];
  R.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); });
  });
  cats.sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; catEl.appendChild(o); });
  chains.sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; chainEl.appendChild(o); });

  var farm = R.farm || {}, farmMeta = R.farm_meta || {}, peers = R.peers || {}, selected = null;
  var EV_RANK = { A: 0, B: 1, C: 2 };

  function bandHtml(r) {
    var scale = r.implied_high_usd * 1.12 || 1;
    var lo = Math.max(0, r.implied_low_usd / scale * 100);
    var hi = Math.min(100, r.implied_high_usd / scale * 100);
    var base = Math.min(100, r.implied_value_usd / scale * 100);
    return '<div class="band"><i style="left:' + lo.toFixed(1) + '%;width:' + Math.max(1.5, hi - lo).toFixed(1) + '%"></i>' +
      '<b style="left:' + base.toFixed(1) + '%"></b></div>' +
      '<span class="band-range">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + ' · ' +
      r.effective_peers + ' eff. peers</span>';
  }

  function filtered() {
    var q = qEl.value.trim().toLowerCase();
    var list = R.rows.filter(function (r) {
      if (watchEl.checked && !r.watchlist) return false;
      if (catEl.value && r.category !== catEl.value) return false;
      if (chainEl.value && r.chains.indexOf(chainEl.value) === -1) return false;
      if (evEl.value && r.evidence !== evEl.value) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var s = sortEl.value;
    var cmp = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd || a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d === null ? -Infinity : b.change_7d) - (a.change_7d === null ? -Infinity : a.change_7d); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      band: function (a, b) { return (b.implied_high_usd - b.implied_low_usd) - (a.implied_high_usd - a.implied_low_usd); },
      evidence: function (a, b) { return EV_RANK[a.evidence] - EV_RANK[b.evidence] || b.effective_peers - a.effective_peers || a.rank - b.rank; },
      name: function (a, b) { return a.name < b.name ? -1 : 1; }
    }[s] || function (a, b) { return a.rank - b.rank; };
    return list.slice().sort(cmp);
  }

  function render() {
    var list = filtered();
    countEl.textContent = list.length + ' of ' + R.rows.length + ' protocols shown';
    var html = '';
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="early">EARLY</span>') +
        '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + chip(r.category) + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ') || '—') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + age(r.age_days) + '</td>' +
        '<td>' + evChip(r.evidence) + '</td>' +
        '<td class="num implied"><strong class="ival">' + money(r.implied_value_usd) + '</strong>' + bandHtml(r) + '</td></tr>';
    });
    rowsEl.innerHTML = html || '<tr><td colspan="9">No protocols match these filters.</td></tr>';
    liveEl.hidden = !liveTEl.checked;
    if (liveTEl.checked) renderLive();
  }

  function renderLive() {
    var html = '';
    R.live.forEach(function (p) {
      var ratio = p.mcap_usd && p.tvl_usd ? (p.mcap_usd / p.tvl_usd).toFixed(2) + 'x' : '—';
      html += '<tr><td><span class="pname">' + esc(p.name) + '</span><span class="slug">' + esc(p.slug) + '</span></td>' +
        '<td>' + chip(p.category) + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + money(p.mcap_usd || 0) + '</td><td class="num">' + ratio + '</td></tr>';
    });
    $('live-rows').innerHTML = html;
  }

  function showDetail(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    selected = slug;
    $('d-name').textContent = '#' + r.rank + ' — ' + r.name;
    $('d-meta').textContent = (r.category || 'Uncategorised') + ' · ' + (r.chains.join(', ') || 'no chain listed') +
      ' · TVL ' + money(r.tvl_usd) + ' · 7d ' + (r.change_7d === null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') +
      ' · tracked since ' + (r.listed_at || 'unknown') + ' (' + age(r.age_days) + ')' +
      (r.watchlist ? ' · on the watchlist' : ' · early find below the $50M floor') +
      ' · evidence grade ' + r.evidence;
    var scale = r.implied_high_usd * 1.12 || 1;
    var lo = Math.max(0, r.implied_low_usd / scale * 100), hi = Math.min(100, r.implied_high_usd / scale * 100);
    var fill = $('d-band-fill'), dot = $('d-band-dot');
    fill.style.left = lo.toFixed(1) + '%'; fill.style.width = Math.max(1.5, hi - lo).toFixed(1) + '%';
    dot.style.left = Math.min(100, r.implied_value_usd / scale * 100).toFixed(1) + '%';
    $('d-low').textContent = 'Low ' + money(r.implied_low_usd);
    $('d-base').textContent = 'Base ' + money(r.implied_value_usd);
    $('d-high').textContent = 'High ' + money(r.implied_high_usd);
    var missing = [];
    if (r.change_7d === null) missing.push('its 7-day change');
    if (r.listed_at === null) missing.push('its listing date');
    $('d-band-note').textContent = 'Band from the ' + (r.category || 'uncategorised') + ' peer multiples at this protocol\u2019s scale: P25 ' +
      r.multiple_p25.toFixed(3) + 'x, median ' + r.category_multiple.toFixed(3) + 'x, P75 ' + r.multiple_p75.toFixed(3) +
      'x, from ' + r.peer_count + (r.peer_count === 1 ? ' trading peer' : ' trading peers') + ' (' + r.effective_peers + ' effective after scale weighting).' +
      (r.band_widen > 1 ? ' The band is widened \u00d7' + r.band_widen.toFixed(2) + ' because the snapshot leaves ' + missing.join(' and ') + ' unreported; the base value does not move.' : '');
    // The driver chain: start from TVL at the global multiple, then apply each
    // factor in turn. Products of the rounded factors are shown with ≈; the base
    // value itself is the model's stored figure.
    var atGlobal = r.tvl_usd * r.global_multiple;
    var atCat = r.tvl_usd * r.category_multiple;
    var catEffect = r.global_multiple > 0 ? (r.category_multiple / r.global_multiple) : 1;
    $('d-model').innerHTML =
      '<dt>TVL at the global multiple</dt><dd>' + money(r.tvl_usd) + ' &times; ' + r.global_multiple.toFixed(3) + 'x &asymp; <strong>' + money(atGlobal) + '</strong> (the scale-weighted global peer median for a protocol of this size)</dd>' +
      '<dt>Category effect</dt><dd>&times;' + catEffect.toFixed(3) + ' — the ' + esc(r.category || 'uncategorised') + ' median is ' + r.category_multiple.toFixed(3) + 'x after shrinkage toward the global quartiles &asymp; ' + money(atCat) + '</dd>' +
      '<dt>Growth multiplier</dt><dd>' + r.growth_multiplier.toFixed(4) + ' (7d change ' + (r.change_7d === null ? 'unreported, counted neutral' : r.change_7d.toFixed(1) + '%, concave response') + ')</dd>' +
      '<dt>Maturity multiplier</dt><dd>' + r.maturity_multiplier.toFixed(4) + ' (log-age at ' + age(r.age_days) + ' with no token)</dd>' +
      '<dt>Breadth multiplier</dt><dd>' + r.breadth_multiplier.toFixed(4) + ' (' + r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains') + ')</dd>' +
      '<dt>Implied value (base)</dt><dd><strong>' + money(r.implied_value_usd) + '</strong> — low ' + money(r.implied_low_usd) + ', high ' + money(r.implied_high_usd) + '; evidence grade ' + r.evidence + '</dd>';
    var comps = peers[slug] || [];
    $('d-peers').innerHTML = comps.length ? comps.map(function (p) {
      return '<tr><td><span class="pname">' + esc(p.name) + '</span><span class="slug">' + esc(p.slug) + '</span></td>' +
        '<td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + p.ratio.toFixed(3) + 'x</td><td class="num">' + p.weight.toFixed(2) + '</td></tr>';
    }).join('') : '<tr><td colspan="5">No trading peers in this category in the snapshot; the row is priced on the global peer quartiles.</td></tr>';
    $('d-peers-note').textContent = comps.length
      ? 'The five peers whose scale is nearest ' + r.name + '\u2019s, of the ' + r.peer_count + ' in its category set after hygiene and trimming. Weight is 1 / (1 + |log\u2081\u2080(peer TVL / this TVL)|): 1.00 at the same scale, about 0.50 one decade away. The full set sets the multiples; these five carry the most weight.'
      : 'Priced on the global peer quartiles (median ' + R.model.global_multiple.toFixed(3) + 'x across ' + R.model.global_peers + ' launch-comparable trading protocols after trimming).';
    var fm = farmMeta[slug] || { capital_usd: 0, est_gas_usd: 0, active_minutes: 0, hold_days: 0 };
    $('d-plan-kind').textContent = r.archetype_label + ' · ' + (farm[slug] || []).length + ' steps';
    $('d-budget').textContent = 'Plan budget: ' + money(fm.capital_usd) + ' of capital · about ' + money(fm.est_gas_usd) +
      ' of gas in total · about ' + hours(fm.active_minutes) + ' of active work · ' + fm.hold_days + '-day hold. ' +
      'Gas is summed from the plan\u2019s own steps at this protocol\u2019s chain prices.';
    $('d-farm').innerHTML = (farm[slug] || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailEl.hidden = false;
    detailEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    render();
  }

  function renderCatPricing() {
    var cp = R.model.category_pricing || {};
    var names = Object.keys(cp).sort(function (a, b) {
      return cp[b].peers - cp[a].peers || (a < b ? -1 : 1);
    });
    $('catpr-rows').innerHTML = names.map(function (c) {
      var v = cp[c];
      return '<tr><td>' + chip(c === '(none)' ? '' : c) + '</td><td class="num">' + money(v.at_tvl) + '</td>' +
        '<td class="num">' + v.peers + '</td><td class="num">' + v.effective_peers + '</td>' +
        '<td class="num">' + v.p25.toFixed(3) + 'x</td><td class="num"><strong>' + v.multiple.toFixed(3) + 'x</strong></td>' +
        '<td class="num">' + v.p75.toFixed(3) + 'x</td></tr>';
    }).join('');
    $('gq-med').textContent = R.model.global_multiple.toFixed(3);
    $('gq-p25').textContent = R.model.global_p25.toFixed(3);
    $('gq-p75').textContent = R.model.global_p75.toFixed(3);
    $('gq-n').textContent = R.model.global_peers;
    $('gq-raw').textContent = R.model.global_peers_raw;
  }
  renderCatPricing();

  // Column headers sort too: clicking one drives the same sort select.
  Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
    th.addEventListener('click', function () { sortEl.value = th.getAttribute('data-sort'); render(); });
  });

  rowsEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) showDetail(tr.getAttribute('data-slug'));
  });
  $('detail-close').addEventListener('click', function () { detailEl.hidden = true; selected = null; render(); });
  [qEl, catEl, chainEl, evEl, sortEl, watchEl, liveTEl].forEach(function (el) { el.addEventListener('input', render); el.addEventListener('change', render); });

  // Deep links: query string first, then the hash (both harmless when absent).
  var state = new URLSearchParams(location.search);
  if (!state.get('detail') && !state.get('cat') && !state.get('chain') && location.hash.length > 1) {
    state = new URLSearchParams(location.hash.slice(1));
  }
  if (state.get('cat')) catEl.value = state.get('cat');
  if (state.get('chain')) chainEl.value = state.get('chain');
  if (state.get('ev')) evEl.value = state.get('ev');
  if (state.get('q')) qEl.value = state.get('q');
  if (state.get('sort')) sortEl.value = state.get('sort');
  if (state.get('watch') === '1') watchEl.checked = true;
  if (state.get('live') === '1') liveTEl.checked = true;
  render();
  if (state.get('detail')) showDetail(state.get('detail'));
})();

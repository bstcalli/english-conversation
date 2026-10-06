'use strict';

// ================= 상태 =================
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null; // 데이터
// Electron에선 ../audio, 웹(휴대폰) 버전에선 같은 폴더의 audio/
const AUDIO_BASE = window.api ? '../audio/' : 'audio/';
const S = { view: 'home', sideMode: 'level', lessonId: null, tab: 'chat', idq: '', idLevel: 'all', idCat: 'all' };
const store = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem('se.v1') || '{}'); } catch { v = {}; }
  v.done ||= {}; v.stars ||= {}; v.rate ||= 1; v.ko ??= true; v.hideEn ??= false; v.exp ??= false;
  return v;
})();
const save = () => { try { localStorage.setItem('se.v1', JSON.stringify(store)); } catch { /* 저장 실패해도 동작 */ } };

const lessonById = (id) => D.lessons.find((l) => l.id === id);
const levelName = (id) => (D.levels.find((l) => l.id === id) || {}).name || id;
const themeOf = (id) => D.themes.find((t) => t.id === id) || { name: id, emoji: '•' };
const seriesName = (id) => (D.series.find((s) => s.id === id) || {}).name || '';
const lvChip = (lv) => `<span class="chip lv-${lv}">${esc(levelName(lv))}</span>`;

// ================= 재생 =================
const player = new Audio();
player.preservesPitch = true;
let playToken = 0; // 순차 재생 취소용
let playingRow = null;

function setNow(text) { $('#pbNow').textContent = text || ''; const m = document.getElementById('mtopNow'); if (m) m.textContent = text || ''; }
function markRow(el) {
  if (playingRow) playingRow.classList.remove('playing');
  playingRow = el || null;
  if (playingRow) { playingRow.classList.add('playing'); playingRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function speakFallback(text, rate, lang = 'en-US') {
  return new Promise((res) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = rate;
    u.onend = res; u.onerror = res;
    speechSynthesis.speak(u);
  });
}

// 한 문장 재생. 끝나면 resolve
function playClip(file, text, lang) {
  player.pause();
  speechSynthesis.cancel();
  setNow('🔊 ' + text);
  if (!file) return speakFallback(text, store.rate, lang);
  return new Promise((res) => {
    player.src = AUDIO_BASE + file;
    player.playbackRate = store.rate;
    player.onended = res;
    player.onerror = () => speakFallback(text, store.rate, lang).then(res);
    player.play().catch(() => res());
  });
}
function stopAll() {
  playToken++;
  player.pause();
  speechSynthesis.cancel();
  markRow(null);
  setNow('');
  stopRecording();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const durCache = {};
function clipDuration(file, text) {
  const guess = Math.max(1.2, text.split(/\s+/).length * 0.38);
  if (!file) return Promise.resolve(guess);
  if (durCache[file]) return Promise.resolve(durCache[file]);
  return new Promise((res) => {
    const a = new Audio(AUDIO_BASE + file);
    a.onloadedmetadata = () => { durCache[file] = a.duration || guess; res(durCache[file]); };
    a.onerror = () => res(guess);
  });
}

// ================= 녹음 (내 발음 비교) =================
let stream = null, rec = null, recChunks = [], recDone = null;
const recordings = {}; // key → blob url
async function ensureMic() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return stream;
}
async function startRecording(key) {
  await ensureMic();
  stopRecording();
  recChunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  const p = new Promise((res) => { recDone = res; });
  rec.onstop = () => {
    if (recordings[key]) URL.revokeObjectURL(recordings[key]);
    recordings[key] = URL.createObjectURL(new Blob(recChunks, { type: rec.mimeType }));
    rec = null;
    recDone && recDone(recordings[key]);
  };
  rec.start();
  return p;
}
function stopRecording() { if (rec && rec.state !== 'inactive') rec.stop(); }
function playUrl(url) {
  return new Promise((res) => {
    player.pause();
    player.src = url;
    player.playbackRate = 1;
    player.onended = res;
    player.onerror = res;
    player.play().catch(() => res());
  });
}

// ================= 숙어 자동 표시 =================
let idiomForms = [];
function buildIdiomIndex() {
  idiomForms = [];
  for (const it of D.idioms) {
    const forms = new Set([...(it.forms || []), it.en].map((f) => String(f).toLowerCase().replace(/^(a|an|the|to) /, '').trim()));
    for (const f of forms) if (f.length >= 4) idiomForms.push({ f, it });
  }
  idiomForms.sort((a, b) => b.f.length - a.f.length);
}
const hitCache = new Map();
function findIdioms(text) {
  if (hitCache.has(text)) return hitCache.get(text);
  const low = text.toLowerCase();
  const hits = [];
  for (const { f, it } of idiomForms) {
    let i = low.indexOf(f);
    while (i !== -1) {
      const before = i === 0 || !/[a-z]/.test(low[i - 1]);
      const after = i + f.length >= low.length || !/[a-z]/.test(low[i + f.length]);
      if (before && after && !hits.some((h) => i < h.end && i + f.length > h.start)) hits.push({ start: i, end: i + f.length, it });
      i = low.indexOf(f, i + 1);
    }
  }
  hits.sort((a, b) => a.start - b.start);
  hitCache.set(text, hits);
  return hits;
}
function markIdioms(text) {
  const hits = findIdioms(text);
  let out = '', pos = 0;
  for (const h of hits) {
    out += esc(text.slice(pos, h.start)) + `<span class="idiom-mark" data-idiom="${esc(h.it.id)}">${esc(text.slice(h.start, h.end))}</span>`;
    pos = h.end;
  }
  return out + esc(text.slice(pos));
}
function lessonIdioms(l) {
  const map = new Map();
  for (const line of l.dialogue || []) for (const h of findIdioms(line.en)) map.set(h.it.id, h.it);
  for (const p of l.phrases || []) for (const h of findIdioms(p.en)) map.set(h.it.id, h.it);
  return [...map.values()];
}
// 숙어 id → 그 숙어가 나오는 과 목록 (시작할 때 한 번 계산)
let idiomLessonMap = null;
function idiomLessons(it) {
  if (!idiomLessonMap) {
    idiomLessonMap = new Map();
    for (const l of D.lessons) for (const x of l.dialogue || []) for (const h of findIdioms(x.en)) {
      const arr = idiomLessonMap.get(h.it.id) || [];
      if (!arr.includes(l)) arr.push(l);
      idiomLessonMap.set(h.it.id, arr);
    }
  }
  return idiomLessonMap.get(it.id) || [];
}

// ================= 공통 =================
function starBtn(key) {
  return `<button class="star ${store.stars[key] ? 'on' : ''}" data-star="${esc(key)}" title="복습함에 담기">${store.stars[key] ? '★' : '☆'}</button>`;
}
function progressOf(list) {
  const done = list.filter((l) => store.done[l.id]).length;
  return { done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
}
function lessonCard(l) {
  return `<button class="card" data-open="${l.id}">
    <div class="em">${l.emoji || '💬'}</div>
    <div class="ct">${esc(l.title)} ${store.done[l.id] ? '✅' : ''}</div>
    <div class="cd">${esc(l.titleEn || '')}</div>
    <div style="margin-top:8px">${lvChip(l.level)} ${l.series ? `<span class="chip">${esc(seriesName(l.series))}</span>` : ''}</div>
  </button>`;
}
const LEVEL_ORDER = ['basic', 'elementary', 'intermediate', 'advanced'];
const SERIES_EMOJI = { daily: '🌅', travel: '🧳', dating: '💕', chat: '📱', errands: '🏦', shopping: '🛒', school: '🏫', gov: '🏛️', home: '🏠', leisure: '🎬', business: '💼', friends: '🎉' };
const SERIES_DESC = { daily: '아침에 일어나서 퇴근까지', travel: '비행기·공항·여행지에서 꼭 필요한 상황', dating: '말 걸기부터 고백·화해까지', chat: '문자·DM·단톡 줄임말', errands: '병원 접수·진료, 은행 업무, 우체국 소포', shopping: '마트·계산대·전자제품·면세점·반품·쿠폰', school: '어학원·수업·교수 면담·기숙사·학부모 상담', gov: '비자·운전면허·서류 발급·경찰·대사관·911', home: '수리·이웃·인터넷·세탁소·미용실·헬스장', leisure: '영화관·공연·스포츠·박물관·놀이공원·캠핑', business: '화상회의·거래처 미팅·접대·연봉 협상·이직', friends: '파티·집들이·생일·위로·거절·작별' };
const byLevel = (lv) => D.lessons.filter((l) => l.level === lv);
const byTheme = (th) => D.lessons.filter((l) => l.theme === th);
const bySeries = (s) => D.lessons.filter((l) => l.series === s);

// ================= 사이드 목록 =================
function renderSide() {
  if (S.sideMode === 'words') return renderSideWords();
  if (S.sideMode === 'sents' || S.sideMode === 'sunit') return renderSideSents();
  if (S.sideMode === 'desc' || S.sideMode === 'xles') return renderSideDescribe();
  if (S.sideMode === 'saja') return renderSideSaja();
  if (['gunit', 'rpass', 'wtask'].includes(S.sideMode)) return renderSideCorner();
  const groups = [];
  if (S.sideMode === 'theme') {
    for (const s of D.series) groups.push({ title: `${SERIES_EMOJI[s.id] || '📘'} ${s.name}`, list: bySeries(s.id) });
    for (const t of D.themes) {
      const list = byTheme(t.id).filter((l) => !l.series);
      if (list.length) groups.push({ title: `${t.emoji} ${t.name}`, list });
    }
  } else {
    for (const lv of LEVEL_ORDER) groups.push({ title: levelName(lv), list: byLevel(lv) });
  }
  const cur = S.view === 'lesson' ? S.lessonId : null;
  $('#sideList').innerHTML = groups.map((g) => {
    const p = progressOf(g.list);
    const gk = S.sideMode + ':' + g.title;
    // 기본은 접힘, 지금 보는 과가 든 묶음과 직접 펼친 묶음만 펼침
    const open = store.open?.[gk] ?? g.list.some((l) => l.id === cur);
    return `<div class="side-group"><button class="side-group-title" data-group="${esc(gk)}" style="width:100%;background:none;border:0;cursor:pointer">
        <span>${open ? '▾' : '▸'} ${esc(g.title)}</span><span>${p.done}/${p.total}</span></button>
      ${!open ? '' : g.list.map((l) => `<button class="side-item ${S.view === 'lesson' && S.lessonId === l.id ? 'on' : ''}" data-open="${l.id}">
        <span class="em">${l.emoji || '💬'}</span><span class="t">${esc(l.title)}</span><span class="ck">${store.done[l.id] ? '✓' : ''}</span></button>`).join('')}
    </div>`;
  }).join('');
}
function renderSideWords() {
  const cur = S.view === 'deck' ? S.deckId : null;
  $('#sideList').innerHTML = DECK_GROUPS.map((g) => {
    const list = D.decks.filter((d) => (d.group || 'theme') === g.id);
    if (!list.length) return '';
    const gk = 'words:' + g.id;
    const open = store.open?.[gk] ?? (list.some((d) => d.id === cur) || (!cur && g.id === 'basic'));
    const k = list.reduce((s, d) => s + deckProgress(d).k, 0), n = list.reduce((s, d) => s + d.words.length, 0);
    return `<div class="side-group"><button class="side-group-title" data-group="${esc(gk)}" style="width:100%;background:none;border:0;cursor:pointer">
        <span>${open ? '▾' : '▸'} ${esc(g.name)}</span><span>${k}/${n}</span></button>
      ${!open ? '' : list.map((d) => { const p = deckProgress(d); return `<button class="side-item ${cur === d.id ? 'on' : ''}" data-deck="${esc(d.id)}">
        <span class="em">${d.emoji || '🔤'}</span><span class="t">${esc(d.name)}</span><span class="ck">${p.k === p.n ? '✓' : p.pct ? p.pct + '%' : ''}</span></button>`; }).join('')}
    </div>`;
  }).join('');
}

// ================= 화면들 =================
function viewHome() {
  const all = progressOf(D.lessons);
  const last = store.last && lessonById(store.last);
  const next = D.lessons.find((l) => !store.done[l.id]);
  return `<div class="wrap">
    <div class="hero">
      <div>
        <h1>오늘도 한 상황씩 🙌</h1>
        <p class="sub" style="margin:0">완전 기초부터 고급까지, 실제 상황 대화로 듣고 따라 말하고 역할극까지.</p>
        <div class="lesson-actions">
          ${last ? `<button class="btn primary" data-open="${last.id}">▶ 이어서: ${esc(last.title)}</button>` : ''}
          ${next && (!last || next.id !== last.id) ? `<button class="btn" data-open="${next.id}">다음 안 한 과: ${esc(next.title)}</button>` : ''}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${all.done}/${all.total}</b><span>완료한 과</span></div>
        <div class="stat"><b>${D.idioms.length}</b><span>숙어</span></div>
        <div class="stat"><b>${Object.keys(store.known || {}).filter((k) => k.startsWith('W:')).length}</b><span>외운 단어</span></div>
        <div class="stat"><b>${Object.keys(store.known || {}).filter((k) => k.startsWith('S:')).length}</b><span>외운 문장</span></div>
        <div class="stat"><b>${Object.keys(store.stars).length}</b><span>복습함</span></div>
      </div>
    </div>

    <h2>📶 레벨별</h2>
    <div class="cards">${LEVEL_ORDER.map((lv) => {
      const p = progressOf(byLevel(lv));
      return `<button class="card" data-level="${lv}"><div class="ct">${lvChip(lv)}</div>
        <div class="cd">${p.total}개 상황 · ${p.done}개 완료</div><div class="bar"><i style="width:${p.pct}%"></i></div></button>`;
    }).join('')}</div>

    <h2>🧭 상황별</h2>
    <div class="cards">
      ${D.series.map((s) => {
        const p = progressOf(bySeries(s.id));
        return `<button class="card" data-theme-go="series:${s.id}"><div class="em">${SERIES_EMOJI[s.id] || '📘'}</div>
          <div class="ct">${esc(s.name)}</div><div class="cd">${SERIES_DESC[s.id] || ''} · ${p.total}개</div>
          <div class="bar"><i style="width:${p.pct}%"></i></div></button>`;
      }).join('')}
      ${D.themes.filter((t) => byTheme(t.id).length).map((t) => {
        const p = progressOf(byTheme(t.id));
        return `<button class="card" data-theme-go="theme:${t.id}"><div class="em">${t.emoji}</div><div class="ct">${esc(t.name)}</div>
          <div class="cd">${p.total}개 상황</div><div class="bar"><i style="width:${p.pct}%"></i></div></button>`;
      }).join('')}
    </div>
  </div>`;
}

function viewLevels() {
  return `<div class="wrap"><h1>📶 레벨별 보기</h1><p class="sub">완전 기초에서 시작해 고급까지 차례대로.</p>
    ${LEVEL_ORDER.map((lv) => `<h2 id="sec-${lv}">${lvChip(lv)} <span style="margin-left:6px">${esc(levelName(lv))}</span></h2>
      <div class="cards">${byLevel(lv).map(lessonCard).join('') || '<div class="empty">준비 중</div>'}</div>`).join('')}
  </div>`;
}

function viewThemes() {
  return `<div class="wrap"><h1>🧭 상황별 보기</h1><p class="sub">하루 일과, 여행, 식당·카페… 필요한 상황을 바로 골라 보세요.</p>
    <div class="chips" style="margin-bottom:6px">${D.series.map((s) => `<button class="fchip" data-jump="sec-series-${s.id}">${SERIES_EMOJI[s.id] || '📘'} ${esc(s.name)}</button>`).join('')}</div>
    ${D.series.map((s) => `<h2 id="sec-series-${s.id}">${SERIES_EMOJI[s.id] || '📘'} ${esc(s.name)}</h2>
      <div class="cards">${bySeries(s.id).map(lessonCard).join('')}</div>`).join('')}
    ${D.themes.map((t) => {
      const list = byTheme(t.id).filter((l) => !l.series);
      return list.length ? `<h2 id="sec-theme-${t.id}">${t.emoji} ${esc(t.name)}</h2><div class="cards">${list.map(lessonCard).join('')}</div>` : '';
    }).join('')}
  </div>`;
}

function viewLesson() {
  const l = lessonById(S.lessonId);
  if (!l) return '<div class="empty">과를 찾을 수 없어요.</div>';
  const th = themeOf(l.theme);
  const tabs = [['chat', '💬 대화'], ['phrases', '🔑 핵심 표현'], ['points', '📖 해설·문법'], ['roleplay', '🎭 역할극'], ['typing', '⌨️ 타이핑']];
  let body = '';
  if (S.tab === 'chat') body = chatHtml(l);
  else if (S.tab === 'phrases') body = phrasesHtml(l);
  else if (S.tab === 'points') body = pointsHtml(l);
  else if (S.tab === 'typing') body = '<p class="sub">영어는 결국 암기! 한국어 뜻만 보고 영어 문장을 직접 쳐 보세요.</p>' + typingShell(l.id);
  else body = roleplayHtml(l);
  const idx = D.lessons.indexOf(l);
  const prev = D.lessons[idx - 1], next = D.lessons[idx + 1];
  return `<div class="wrap">
    <div class="lesson-head">
      <div class="big">${l.emoji || '💬'}</div>
      <div style="flex:1">
        <div>${lvChip(l.level)} <span class="chip">${th.emoji} ${esc(th.name)}</span> ${l.series ? `<span class="chip">${esc(seriesName(l.series))}</span>` : ''}</div>
        <h1 style="margin-top:6px">${esc(l.title)}</h1>
        <p class="sub" style="margin:0">${esc(l.titleEn || '')} · ${esc(l.desc || '')}</p>
      </div>
      <button class="btn ${store.done[l.id] ? 'on' : ''}" data-act="done" style="flex:none">${store.done[l.id] ? '✅ 학습 완료' : '☐ 학습 완료'}</button>
    </div>
    <div class="lesson-actions">
      <button class="btn primary" data-act="playall">▶ 대화 전체 듣기</button>
      <button class="btn" data-act="shadow">🗣 따라 말하기 (문장마다 멈춤)</button>
      <button class="btn" data-act="stop">■ 멈춤</button>
    </div>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}
    <div class="lesson-actions" style="margin-top:28px; justify-content:space-between">
      ${prev ? `<button class="btn" data-open="${prev.id}">← ${esc(prev.title)}</button>` : '<span></span>'}
      ${next ? `<button class="btn" data-open="${next.id}">${esc(next.title)} →</button>` : ''}
    </div>
  </div>`;
}

function speakerName(l, s) {
  const sp = (l.speakers || {})[s] || {};
  if (s === 'B') return sp.role && sp.role !== '나' ? `나 (${sp.role})` : '나';
  return sp.role ? `${sp.name || s} · ${sp.role}` : sp.name || s;
}
function chatHtml(l) {
  return `<div class="chat ${store.hideEn ? 'hide-en' : ''} ${store.ko ? '' : 'no-ko'}">
    ${(l.dialogue || []).map((line, i) => {
      const key = `L:${l.id}:d${i}`;
      const me = line.s === 'B';
      const sp = (l.speakers || {})[line.s] || {};
      return `<div class="row ${me ? 'me' : ''}" data-line="${i}">
        <div class="avatar">${me ? '나' : esc((sp.name || line.s).slice(0, 1))}</div>
        <div class="bubble">
          <div class="who">${esc(speakerName(l, line.s))}</div>
          <div class="en" data-play-line="${i}"><span class="txt">${markIdioms(line.en)}</span></div>
          ${line.say ? `<div class="note">🗣 풀어 읽으면: ${esc(line.say)}</div>` : ''}
          <div class="ko">${esc(line.ko)}</div>
          <div class="tools">
            <button class="tool" data-play-line="${i}">🔊 듣기</button>
            <button class="tool" data-repeat="${i}">🔁 3번</button>
            <button class="tool" data-rec="${i}">🎙 내 발음 녹음</button>
            <button class="tool" data-myrec="${i}" ${recordings[key] ? '' : 'disabled style="opacity:.4"'}>▶ 내 녹음</button>
            ${line.exp ? `<button class="tool ${store.exp ? 'on' : ''}" data-exp="${i}">💡 해설</button>` : ''}
            ${starBtn(key)}
          </div>
          ${line.exp ? `<div class="exp" data-exp-box="${i}" ${store.exp ? '' : 'hidden'}>${esc(line.exp)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
function phrasesHtml(l) {
  return `<p class="sub">이 상황에서 바로 꺼내 쓰는 표현들이에요. 문장을 누르면 발음이 나와요.</p>
  <div class="phr ${store.ko ? '' : 'no-ko'}">${(l.phrases || []).map((p, i) => `<div class="phr-item">
    <button class="play" data-play-phrase="${i}">▶</button>
    <div><div class="en" data-play-phrase="${i}">${markIdioms(p.en)}</div>${p.say ? `<div class="note">🗣 ${esc(p.say)}</div>` : ''}<div class="ko">${esc(p.ko)}</div>${p.note ? `<div class="note">💡 ${esc(p.note)}</div>` : ''}</div>
    ${starBtn(`L:${l.id}:p${i}`)}
  </div>`).join('')}</div>`;
}
function pointsHtml(l) {
  const ids = lessonIdioms(l);
  const lineExps = (l.dialogue || []).filter((x) => x.exp);
  return `${(l.points || []).map((p) => `<div class="point"><h3>📌 ${esc(p.title)}</h3><p>${esc(p.body)}</p></div>`).join('')}
    ${l.culture ? `<div class="point culture"><h3>🌏 문화 팁</h3><p>${esc(l.culture)}</p></div>` : ''}
    ${ids.length ? `<h2>📚 이 대화에 나온 숙어</h2><div class="idiom-list">${ids.map(idiomCard).join('')}</div>` : ''}
    ${lineExps.length ? `<h2>💡 문장별 해설 모아보기</h2>
      <div class="phr">${(l.dialogue || []).map((x, i) => x.exp ? `<div class="phr-item"><button class="play" data-play-line="${i}">▶</button>
        <div><div class="en" data-play-line="${i}">${esc(x.en)}</div><div class="ko">${esc(x.ko)}</div><div class="note">${esc(x.exp)}</div></div><span></span></div>` : '').join('')}</div>` : ''}
    ${!(l.points || []).length && !l.culture && !lineExps.length ? '<div class="empty">해설 준비 중</div>' : ''}`;
}

// 역할극
const RP = { role: 'B', running: false, step: -1, phase: '', results: [] };
function roleplayHtml(l) {
  const sp = l.speakers || {};
  const roleName = (s) => s === 'B' ? `나 (${(sp.B || {}).role || '나'})` : `${(sp.A || {}).name || 'A'} (${(sp.A || {}).role || ''})`;
  const myLines = (l.dialogue || []).map((x, i) => ({ x, i })).filter(({ x }) => x.s === RP.role);
  return `<p class="sub">상대 대사는 원어민이 말해 주고, 내 차례에는 한국어 뜻만 보여요. 영어로 말하면 자동으로 녹음되고, 바로 원어민 발음을 들려줘요.</p>
    <div class="rp-setup">
      <span>내 역할:</span>
      <div class="seg">${['B', 'A'].map((s) => `<button data-rprole="${s}" class="${RP.role === s ? 'on' : ''}">${esc(roleName(s))}</button>`).join('')}</div>
      <button class="btn primary" data-act="rpstart">${RP.running ? '⟳ 처음부터 다시' : '🎭 역할극 시작'}</button>
      ${RP.running ? '<button class="btn" data-act="stop">■ 그만</button>' : ''}
    </div>
    <div class="rp-stage" id="rpStage">${RP.running ? '' : '<div class="rp-hint">🎙 마이크가 필요해요. 시작을 누르면 처음 한 번 마이크 허용을 물어볼 수 있어요.</div>'}</div>
    <h2>내 대사 다시 듣기</h2>
    <div class="chat rp-result">${myLines.map(({ x, i }) => {
      const key = `RP:${l.id}:${i}`;
      return `<div class="row me"><div class="avatar">나</div><div class="bubble">
        <div class="en" data-play-line="${i}">${esc(x.en)}</div><div class="ko">${esc(x.ko)}</div>
        <div class="tools"><button class="tool" data-play-line="${i}">🔊 원어민</button>
        <button class="tool" data-rpmy="${i}" ${recordings[key] ? '' : 'disabled style="opacity:.4"'}>▶ 내 목소리</button></div>
      </div></div>`;
    }).join('') || '<div class="empty">대사가 없어요</div>'}</div>`;
}
async function runRoleplay(l) {
  stopAll();
  const token = ++playToken;
  RP.running = true;
  render();
  try { await ensureMic(); } catch {
    $('#rpStage').innerHTML = '<div class="rp-hint">⚠️ 마이크를 쓸 수 없어요. 녹음 없이 진행합니다.</div>';
    await sleep(1500);
  }
  const lines = l.dialogue || [];
  const voices = l.voices || {};
  for (let i = 0; i < lines.length; i++) {
    if (token !== playToken) return;
    const x = lines[i];
    const stage = $('#rpStage');
    if (!stage) return;
    if (x.s !== RP.role) {
      stage.innerHTML = `<div class="rp-cue">${esc(speakerName(l, x.s))}</div><div class="rp-ko" style="font-weight:600">${esc(x.en)}</div><div class="rp-hint">${esc(x.ko)}</div>`;
      await playClip(x.audio, x.say || x.en);
    } else {
      const dur = await clipDuration(x.audio, x.say || x.en);
      const ms = Math.round(Math.max(2.5, dur * 1.7 / store.rate + 1.2) * 1000);
      stage.innerHTML = `<div class="rp-cue">🎙 내 차례 — 영어로 말해 보세요</div><div class="rp-ko">${esc(x.ko)}</div>
        <button class="tool" id="rpPeek">👀 영어 살짝 보기</button> <span id="rpPeekTxt" class="rp-hint"></span>
        <div class="rp-timer"><i id="rpBar"></i></div>`;
      $('#rpPeek').onclick = () => { $('#rpPeekTxt').textContent = x.en; };
      const bar = $('#rpBar');
      bar.style.transition = `width ${ms}ms linear`;
      requestAnimationFrame(() => { bar.style.width = '100%'; });
      setNow('🎙 녹음 중…');
      let done = null;
      if (stream) done = startRecording(`RP:${l.id}:${i}`);
      await sleep(ms);
      if (token !== playToken) return;
      stopRecording();
      if (done) await done;
      stage.innerHTML = `<div class="rp-cue">✅ 원어민은 이렇게 말해요</div><div class="rp-ko">${esc(x.en)}</div><div class="rp-hint">${esc(x.ko)}</div>`;
      await playClip(x.audio, x.say || x.en);
      await sleep(500);
    }
  }
  if (token !== playToken) return;
  RP.running = false;
  setNow('');
  render();
  const st = $('#rpStage');
  if (st) st.innerHTML = '<div class="rp-ko">🎉 역할극 끝! 아래에서 내 목소리와 원어민 발음을 비교해 보세요.</div>';
}

// 숙어 사전
function idiomCard(it) {
  const lessons = idiomLessons(it);
  const cat = (D.idiomCategories.find((c) => c.id === it.cat) || {}).name || '';
  return `<div class="idiom">
    <div class="idiom-top"><button class="play" data-idplay="${esc(it.id)}:h">▶</button><span class="idiom-en">${esc(it.en)}</span>
      ${lvChip(it.level)} ${cat ? `<span class="chip">${esc(cat)}</span>` : ''}<span style="flex:1"></span>${starBtn('I:' + it.id)}</div>
    <div class="idiom-ko">${esc(it.ko)}</div>
    ${it.ex ? `<div class="ex"><button class="play" data-idplay="${esc(it.id)}:1">▶</button><div><div class="ex-en">${esc(it.ex)}</div><div class="ex-ko">${esc(it.exKo)}</div></div></div>` : ''}
    ${it.ex2 ? `<div class="ex"><button class="play" data-idplay="${esc(it.id)}:2">▶</button><div><div class="ex-en">${esc(it.ex2)}</div><div class="ex-ko">${esc(it.ex2Ko)}</div></div></div>` : ''}
    ${it.note ? `<div class="note">💡 ${esc(it.note)}</div>` : ''}
    ${lessons.length ? `<div class="links">📍 나오는 대화: ${lessons.map((l) => `<a data-open="${l.id}">${esc(l.title)}</a>`).join('')}</div>` : ''}
  </div>`;
}
function viewIdioms() {
  const q = S.idq.trim().toLowerCase();
  const list = D.idioms.filter((it) => (S.idLevel === 'all' || it.level === S.idLevel) && (S.idCat === 'all' || it.cat === S.idCat)
    && (!q || [it.en, it.ko, it.ex, it.exKo, it.note].some((v) => String(v || '').toLowerCase().includes(q))));
  list.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.en.localeCompare(b.en));
  return `<div class="wrap"><h1>📚 숙어 사전</h1><p class="sub">회화에 꼭 나오는 숙어·구동사·관용 표현을 주제별·레벨별로 정리했어요.</p>
    <div class="filters">
      <input class="search" id="idSearch" placeholder="영어나 한국어로 검색 (예: cake, 미루다)" value="${esc(S.idq)}">
      <div class="chips">${[['all', '전체 레벨'], ...LEVEL_ORDER.map((l) => [l, levelName(l)])].map(([k, n]) => `<button class="fchip ${S.idLevel === k ? 'on' : ''}" data-idlv="${k}">${esc(n)}</button>`).join('')}</div>
      <div class="chips">${[['all', '전체 주제'], ...D.idiomCategories.map((c) => [c.id, c.name])].map(([k, n]) => `<button class="fchip ${S.idCat === k ? 'on' : ''}" data-idcat="${k}">${esc(n)}</button>`).join('')}</div>
    </div>
    <div class="count">${list.length}개</div>
    <div class="idiom-list" id="idiomList">${list.map(idiomCard).join('') || '<div class="empty">찾는 숙어가 없어요</div>'}</div>
  </div>`;
}

function viewReview() {
  const keys = Object.keys(store.stars);
  const lines = [], idioms = [], words = [];
  for (const k of keys) {
    const [kind, a, b] = k.split(':');
    if (kind === 'I') { const it = D.idioms.find((x) => x.id === a); if (it) idioms.push(it); continue; }
    if (kind === 'W') { const r = wordByKey(k); if (r) words.push(r); continue; }
    if (kind === 'S') { const un = D.sentUnits.find((x) => x.id === a); const s = un && un.sentences[Number(b)]; if (s) lines.push({ k, l: { id: '', title: `💯 ${un.id.toUpperCase()} ${un.title}`, emoji: '' }, item: s, kind: 's', i: Number(b) }); continue; }
    const l = lessonById(a); if (!l) continue;
    const i = Number(b.slice(1));
    const item = b[0] === 'd' ? (l.dialogue || [])[i] : (l.phrases || [])[i];
    if (item) lines.push({ k, l, item, kind: b[0], i });
  }
  const any = lines.length + words.length;
  return `<div class="wrap"><h1>⭐ 복습함</h1><p class="sub">대화·표현·단어·숙어에서 ☆를 눌러 담아 둔 것들이에요.</p>
    <div class="lesson-actions"><button class="btn primary" data-act="reviewall" ${any ? '' : 'disabled'}>▶ 담은 문장·단어 연속 듣기</button><button class="btn ${S.reviewTyping ? 'on' : ''}" data-act="reviewtype" ${any ? '' : 'disabled'}>⌨️ 담은 것 타이핑</button><button class="btn" data-act="stop">■ 멈춤</button></div>
    ${S.reviewTyping && any ? typingShell('review') : ''}
    <h2>단어 (${words.length})</h2>
    <div class="wlist ${store.ko ? '' : 'no-ko'}">${words.map(({ d, w }) => wordRow(d, w, 0, { showDeck: true })).join('') || '<div class="empty">아직 담은 단어가 없어요</div>'}</div>
    <h2>문장·표현 (${lines.length})</h2>
    <div class="phr ${store.ko ? '' : 'no-ko'}">${lines.map(({ k, l, item, kind, i }) => `<div class="phr-item" data-rv="${esc(k)}">
      <button class="play" data-rvplay="${esc(k)}">▶</button>
      <div><div class="en" data-rvplay="${esc(k)}">${esc(item.en)}</div><div class="ko">${esc(item.ko)}</div>
      <div class="links"><a data-open="${l.id}">${l.emoji || ''} ${esc(l.title)}</a> · ${({ d: '대화', p: '핵심 표현', s: '천 문장' })[kind]}</div></div>
      ${starBtn(k)}</div>`).join('') || '<div class="empty">아직 담은 문장이 없어요</div>'}</div>
    <h2>숙어 (${idioms.length})</h2>
    <div class="idiom-list">${idioms.map(idiomCard).join('') || '<div class="empty">아직 담은 숙어가 없어요</div>'}</div>
  </div>`;
}
function reviewItem(k) {
  const [kind, a, b] = k.split(':');
  if (kind === 'W') { const r = wordByKey(k); return r && wordItem(r.d, r.w); }
  if (kind === 'S') { const un = D.sentUnits.find((x) => x.id === a); const s = un && un.sentences[Number(b)]; return s && { en: s.en, ko: s.ko, audio: s.audio, exp: s.point }; }
  if (kind !== 'L') return null;
  const l = lessonById(a); if (!l) return null;
  const i = Number(b.slice(1));
  return b[0] === 'd' ? (l.dialogue || [])[i] : (l.phrases || [])[i];
}

// ================= 타이핑 연습 (암기용) =================
const CONTR = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "he's": 'he is', "she's": 'she is',
  "it's": 'it is', "that's": 'that is', "what's": 'what is', "there's": 'there is', "here's": 'here is', "where's": 'where is',
  "who's": 'who is', "how's": 'how is', "let's": 'let us', "i've": 'i have', "you've": 'you have', "we've": 'we have',
  "they've": 'they have', "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will', "it'll": 'it will',
  "that'll": 'that will', "he'll": 'he will', "she'll": 'she will', "i'd": 'i would', "you'd": 'you would', "we'd": 'we would',
  "they'd": 'they would', "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "isn't": 'is not', "aren't": 'are not',
  "wasn't": 'was not', "weren't": 'were not', "can't": 'cannot', "couldn't": 'could not', "won't": 'will not',
  "wouldn't": 'would not', "shouldn't": 'should not', "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "mustn't": 'must not', 'gonna': 'going to', 'wanna': 'want to', 'gotta': 'got to',
};
const normWord = (w) => w.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
// 정답 비교용: 대소문자·문장부호 무시, 줄임말은 풀어서 비교 (I'm = I am, can not = cannot)
// 아포스트로피 없이 친 줄임말(im, dont)도 인정. 다른 단어와 겹치는 것(were, well, its, id, ill…)은 제외
const NO_APOS = Object.fromEntries(Object.entries(CONTR).map(([k, v]) => [k.replace(/'/g, ''), v])
  .filter(([k]) => k.length > 0 && !['were', 'well', 'its', 'id', 'ill', 'hell', 'shell', 'wed', 'hed', 'shed', 'lets', 'whos', 'hes'].includes(k)));
function normFull(s) {
  return s.split(/\s+/).map(normWord).filter(Boolean).flatMap((w) => (CONTR[w] || NO_APOS[w] || w).split(' '))
    .join(' ').replace(/\bcan not\b/g, 'cannot').replace(/'/g, '');
}
// 단어 단위 비교: 정답 단어 중 맞게 쓴 것 표시 (LCS)
function wordDiff(expected, typed) {
  const disp = expected.split(/\s+/).filter(Boolean);
  const a = disp.map(normWord), b = typed.split(/\s+/).map(normWord).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const okA = new Set(), okB = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] && a[i] === b[j]) { okA.add(i); okB.add(j); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  const typedDisp = typed.split(/\s+/).filter(Boolean);
  return {
    answer: disp.map((w, i) => `<span class="${okA.has(i) || !a[i] ? 'ty-ok' : 'ty-miss'}">${esc(w)}</span>`).join(' '),
    mine: typedDisp.map((w, j) => `<span class="${okB.has(j) ? 'ty-ok' : 'ty-extra'}">${esc(w)}</span>`).join(' '),
  };
}
const initialHint = (s) => s.split(/\s+/).map((w) => { let first = true; return w.replace(/[A-Za-z]/g, (c) => (first ? ((first = false), c) : '_')); }).join(' ');

const TY = { src: null, mode: 'mine', hint: 'ko', items: [], idx: 0, results: [], phase: 'setup', played: -1 };
// 단어를 타이핑·연속 듣기용 항목으로 (채점 뒤엔 예문과 팁을 해설처럼 보여 줌)
function wordItem(d, w) {
  return { en: w.en, say: w.say, ko: w.ko + (w.pos ? ` (${w.pos})` : ''), audio: w.audio, key: wKey(d, w),
    exp: [w.ex && `${w.ex} — ${w.exKo || ''}`, w.tip && `💡 ${w.tip}`].filter(Boolean).join('\n') };
}
function tyItems(src, mode) {
  let list = [];
  if (src.startsWith('sunit:')) {
    const un = D.sentUnits.find((x) => x.id === src.slice(6));
    list = un ? sentItems(un, mode) : [];
  } else if (src.startsWith('deck:')) {
    const d = deckById(src.slice(5));
    list = d ? d.words.filter((w) => mode !== 'unknown' || !isKnown(d, w)).map((w) => wordItem(d, w)) : [];
  } else if (src === 'review') list = Object.keys(store.stars).map((k) => { const it = reviewItem(k); return it && { ...it, key: k }; }).filter(Boolean);
  else {
    const l = lessonById(src);
    if (mode === 'phrases') list = (l.phrases || []).map((p, i) => ({ ...p, key: `L:${l.id}:p${i}` }));
    else list = (l.dialogue || []).map((x, i) => ({ ...x, key: `L:${l.id}:d${i}` })).filter((x) => mode === 'all' || x.s === 'B');
  }
  return list.filter((x) => normFull(x.en)); // 이모지만 있는 문장 등은 제외
}
function tyStart(items) {
  stopAll();
  TY.items = items || tyItems(TY.src, TY.mode);
  TY.idx = 0; TY.results = []; TY.played = -1; TY.typed = ''; TY.hinted = false;
  TY.phase = TY.items.length ? 'input' : 'setup';
  tyRender();
}
function tyBestKey() { return `${TY.src}:${TY.src === 'review' ? 'review' : TY.mode}`; }
function typingShell(src) {
  if (TY.src !== src) {
    TY.src = src; TY.phase = 'setup'; TY.items = [];
    const deck = src.startsWith('deck:') || src.startsWith('sunit:');
    if (deck && !['all', 'unknown'].includes(TY.mode)) TY.mode = 'all';
    if (!deck && !['mine', 'all', 'phrases'].includes(TY.mode)) TY.mode = 'mine';
  }
  return '<div id="tyBox"></div>';
}
function tyRender() {
  const box = $('#tyBox');
  if (!box) return;
  const seg = (name, cur, opts) => `<div class="seg">${opts.map(([k, n]) => `<button data-${name}="${k}" class="${cur === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  const best = (store.typing || {})[tyBestKey()];
  const setup = `<div class="rp-setup">
      ${TY.src === 'review' ? '<span>⭐ 복습함에 담은 것</span>'
        : TY.src.startsWith('deck:') ? `<span>범위</span>${seg('tymode', TY.mode, [['all', '전체 단어'], ['unknown', '안 외운 단어만']])}`  
        : TY.src.startsWith('sunit:') ? `<span>범위</span>${seg('tymode', TY.mode, [['all', '전체 문장'], ['unknown', '안 외운 문장만']])}`
        : `<span>범위</span>${seg('tymode', TY.mode, [['mine', '내 대사'], ['all', '대화 전체'], ['phrases', '핵심 표현']])}`}
      <span>힌트</span>${seg('tyhint', TY.hint, [['ko', '한국어만'], ['initial', '첫 글자'], ['dict', '듣고 받아쓰기']])}
      <button class="btn primary" data-tyact="start">${TY.phase === 'setup' ? '⌨️ 시작' : '⟳ 처음부터'}</button>
      ${best != null ? `<span class="rp-hint">최고 ${best}점</span>` : ''}
    </div>`;
  if (TY.phase === 'setup') {
    const n = tyItems(TY.src, TY.mode).length;
    box.innerHTML = setup + `<div class="rp-stage"><div class="rp-hint">한국어 뜻을 보고 영어 문장을 그대로 쳐 보세요. 대소문자·문장부호는 안 봐요. I'm = I am 처럼 줄임말을 풀어 써도 정답이에요.<br>
      Enter 확인·다음 · Ctrl+Space 듣기 · Ctrl+H 다음 단어 힌트 · 틀렸을 때 Shift+Enter 다시 쓰기</div>
      <div class="rp-ko" style="margin-top:10px">${n}문장</div></div>`;
    return;
  }
  if (TY.phase === 'done') {
    const ok = TY.results.filter((r) => r && r.ok).length, total = TY.items.length;
    const score = Math.round((ok / total) * 100);
    const wrong = TY.items.map((it, i) => ({ it, r: TY.results[i] })).filter((x) => !x.r || !x.r.ok);
    box.innerHTML = setup + `<div class="rp-stage">
      <div class="rp-ko">${score >= 90 ? '🏆' : score >= 60 ? '👍' : '💪'} ${ok} / ${total} 한 번에 정답 · ${score}점</div>
      <div class="lesson-actions">
        ${wrong.length ? `<button class="btn primary" data-tyact="retrywrong">✍️ 틀린 ${wrong.length}문장만 다시</button>
        <button class="btn" data-tyact="starwrong">☆ 틀린 것 복습함에 담기</button>` : '<span class="rp-hint">전부 한 번에 맞혔어요!</span>'}
        ${(TY.src.startsWith('deck:') || TY.src.startsWith('sunit:')) && ok ? `<button class="btn" data-tyact="knowright">✔ 맞힌 ${ok}단어 외웠어요 표시</button>` : ''}
      </div></div>
      ${wrong.length ? `<h2>다시 볼 문장</h2><div class="phr">${wrong.map(({ it, r }) => `<div class="phr-item">
        <button class="play" data-typlay="${esc(it.key)}">▶</button>
        <div><div class="en">${esc(it.en)}</div><div class="ko">${esc(it.ko)}</div>
        ${r && r.typed ? `<div class="note">내가 쓴 것: ${wordDiff(it.en, r.typed).mine}</div>` : ''}${r && r.hinted ? '<div class="note">💡 힌트 사용</div>' : ''}</div><span></span></div>`).join('')}</div>` : ''}`;
    return;
  }
  const it = TY.items[TY.idx];
  const checked = TY.phase !== 'input';
  const showKo = TY.hint !== 'dict' || checked;
  const r = TY.results[TY.idx];
  const diff = checked ? wordDiff(it.en, TY.typed || '') : null;
  box.innerHTML = setup + `<div class="rp-stage ty-stage ${TY.phase}">
      <div class="rp-cue">${TY.idx + 1} / ${TY.items.length} · 한 번에 정답 ${TY.results.filter((x) => x && x.ok).length}${it.s ? ` · ${it.s === 'B' ? '내 대사' : '상대 대사'}` : ''}</div>
      <div class="rp-ko">${showKo ? esc(it.ko) : '🎧 듣고 그대로 쳐 보세요'}</div>
      ${TY.hint === 'initial' && !checked ? `<div class="ty-hint">${esc(initialHint(it.en))}</div>` : ''}
      <input id="tyInput" class="search ty-input" autocomplete="off" spellcheck="false" placeholder="영어로 입력하고 Enter" ${checked ? 'readonly' : ''} value="${esc(TY.typed || '')}">
      <div class="ty-warn" id="tyWarn" hidden>⚠️ 한글로 입력되고 있어요. 한/영 키를 눌러 주세요.</div>
      <div class="tools" style="margin-top:8px">
        <button class="tool" data-tyact="play">🔊 듣기</button>
        ${checked ? '' : '<button class="tool" data-tyact="hint">💡 다음 단어</button><button class="tool" data-tyact="check">✔ 확인</button>'}
        ${TY.phase === 'wrong' ? '<button class="tool" data-tyact="retry">✍️ 다시 쓰기</button>' : ''}
        ${checked ? `<button class="tool" data-tyact="next">${TY.idx + 1 < TY.items.length ? '다음 →' : '결과 보기'}</button>` : ''}
        <button class="tool" data-tyact="skip" ${checked ? 'hidden' : ''}>모르겠어요</button>
      </div>
      ${checked ? `<div class="ty-result">
        <div class="ty-verdict">${TY.phase === 'right' ? (r && r.ok ? '⭕ 정답!' : '⭕ 맞았어요 (처음엔 틀렸거나 힌트 사용)') : '❌ 아쉬워요'}</div>
        <div class="ty-line"><span class="ty-label">정답</span> ${diff.answer}</div>
        ${TY.phase === 'wrong' && TY.typed ? `<div class="ty-line"><span class="ty-label">내 답</span> ${diff.mine}</div>` : ''}
        ${it.exp ? `<div class="exp">${esc(it.exp)}</div>` : it.note ? `<div class="exp">${esc(it.note)}</div>` : ''}
      </div>` : ''}
    </div>`;
  // 작은 화면에서도 문제·채점 결과가 보이도록 카드를 화면 위쪽에 맞춘다
  box.querySelector('.ty-stage').scrollIntoView({ block: 'start' });
  const inp = $('#tyInput');
  inp.focus({ preventScroll: true });
  inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener('keydown', tyKey);
  inp.addEventListener('input', () => {
    TY.typed = inp.value;
    $('#tyWarn').hidden = !/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(inp.value);
  });
  if (TY.hint === 'dict' && TY.phase === 'input' && TY.played !== TY.idx) { TY.played = TY.idx; playClip(it.audio, it.say || it.en); }
}
function tyCheck() {
  const it = TY.items[TY.idx];
  const typed = ($('#tyInput') || {}).value || '';
  TY.typed = typed;
  const ok = normFull(typed) === normFull(it.en);
  const prev = TY.results[TY.idx];
  if (!prev) TY.results[TY.idx] = { ok: ok && !TY.hinted, typed, hinted: TY.hinted };
  else if (!ok) prev.typed = typed;
  TY.phase = ok ? 'right' : 'wrong';
  tyRender();
  if (ok) playClip(it.audio, it.say || it.en);
}
function tyNext() {
  stopAll();
  TY.typed = ''; TY.hinted = false;
  if (TY.idx + 1 >= TY.items.length) {
    TY.phase = 'done';
    const ok = TY.results.filter((r) => r && r.ok).length;
    const score = Math.round((ok / TY.items.length) * 100);
    store.typing ||= {};
    const k = tyBestKey();
    if (TY.items.length >= 3 && (store.typing[k] == null || score > store.typing[k])) { store.typing[k] = score; save(); }
  } else { TY.idx++; TY.phase = 'input'; }
  tyRender();
}
function tyHint() {
  const it = TY.items[TY.idx];
  const inp = $('#tyInput');
  const exp = it.en.split(/\s+/).filter(Boolean);
  const typed = inp.value.split(/\s+/).filter(Boolean);
  let n = 0;
  while (n < typed.length && n < exp.length && normWord(typed[n]) === normWord(exp[n])) n++;
  inp.value = exp.slice(0, n + 1).join(' ') + (n + 1 < exp.length ? ' ' : '');
  TY.typed = inp.value; TY.hinted = true;
  inp.focus();
}
function tyKey(e) {
  if (e.isComposing) return;
  if (e.ctrlKey && (e.code === 'Space')) { e.preventDefault(); const it = TY.items[TY.idx]; playClip(it.audio, it.say || it.en); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'h') { e.preventDefault(); if (TY.phase === 'input') tyHint(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (TY.phase === 'input') tyCheck();
  else if (TY.phase === 'wrong' && e.shiftKey) { TY.phase = 'input'; tyRender(); }
  else tyNext();
}
function tyAction(act, t) {
  if (act === 'start') return tyStart();
  if (act === 'check') return tyCheck();
  if (act === 'next') return tyNext();
  if (act === 'hint') return tyHint();
  if (act === 'retry') { TY.phase = 'input'; return tyRender(); }
  if (act === 'skip') { TY.typed = ($('#tyInput') || {}).value || ''; TY.results[TY.idx] = TY.results[TY.idx] || { ok: false, typed: TY.typed }; TY.phase = 'wrong'; return tyRender(); }
  if (act === 'play') { const it = TY.items[TY.idx]; if (it) playClip(it.audio, it.say || it.en); $('#tyInput')?.focus(); return; }
  if (act === 'retrywrong') return tyStart(TY.items.filter((x, i) => !TY.results[i] || !TY.results[i].ok));
  if (act === 'knowright') {
    TY.items.forEach((x, i) => { if (TY.results[i] && TY.results[i].ok) setKnown(x.key, true); });
    renderSide(); t.textContent = '✔ 표시했어요'; t.disabled = true; return;
  }
  if (act === 'starwrong') {
    TY.items.forEach((x, i) => { if ((!TY.results[i] || !TY.results[i].ok) && x.key) store.stars[x.key] ||= Date.now(); });
    save(); renderSide(); t.textContent = '★ 담았어요'; t.disabled = true;
  }
}

// ================= 단어장 =================
const DECK_GROUPS = [
  { id: 'basic', name: '🔤 기초 필수', desc: '숫자·날짜·날씨부터 완전 기초 단어까지' },
  { id: 'theme', name: '🧭 상황별 단어', desc: '마트·카페·공항… 그 장소에서 바로 쓰는 단어' },
  { id: 'level', name: '📈 레벨별 필수 어휘', desc: '초급부터 고급·비즈니스·시사·학술까지' },
];
const WS = { q: '', onlyUnknown: false };
const deckById = (id) => D.decks.find((d) => d.id === id);
const wKey = (d, w) => `W:${d.id}:${w.en}`;
const isKnown = (d, w) => !!(store.known || {})[wKey(d, w)];
function setKnown(key, v) { store.known ||= {}; if (v) store.known[key] = Date.now(); else delete store.known[key]; save(); }
function wordByKey(k) {
  const rest = k.slice(2), i = rest.indexOf(':');
  const d = deckById(rest.slice(0, i)); if (!d) return null;
  const w = d.words.find((x) => x.en === rest.slice(i + 1));
  return w ? { d, w } : null;
}
function deckProgress(d) {
  const k = d.words.filter((w) => isKnown(d, w)).length;
  return { k, n: d.words.length, pct: d.words.length ? Math.round((k / d.words.length) * 100) : 0 };
}
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const deckIdx = (d) => d.words.map((w, i) => i).filter((i) => !WS.onlyUnknown || !isKnown(d, d.words[i]));

function deckCard(d) {
  const p = deckProgress(d);
  return `<button class="card" data-deck="${esc(d.id)}">
    <div class="em">${d.emoji || '🔤'}</div>
    <div class="ct">${esc(d.name)} ${p.k === p.n && p.n ? '✅' : ''}</div>
    <div class="cd">${esc(d.nameEn || '')} · ${p.n}단어</div>
    <div style="margin-top:6px">${lvChip(d.level)}</div>
    <div class="bar"><i style="width:${p.pct}%"></i></div></button>`;
}
function wordRow(d, w, i, { showDeck = false } = {}) {
  const key = wKey(d, w), known = isKnown(d, w);
  return `<div class="wrow ${known ? 'known' : ''}">
    <button class="play" data-wplay="${esc(key)}">▶</button>
    <div class="wmain" data-wtoggle="${esc(key)}">
      <div><span class="wen">${esc(w.en)}</span> ${w.ipa ? `<span class="ipa">${esc(w.ipa)}</span>` : ''} ${w.pos ? `<span class="pos">${esc(w.pos)}</span>` : ''}
        ${w.say ? `<span class="ipa">🗣 ${esc(w.say)}</span>` : ''} ${showDeck ? `<span class="chip">${d.emoji || ''} ${esc(d.name)}</span>` : ''}</div>
      <div class="wko">${esc(w.ko)}</div>
      <div class="wmore" data-wmore="${esc(key)}" ${store.exp ? '' : 'hidden'}>
        ${w.ex ? `<div class="ex"><button class="play" data-wex="${esc(key)}">▶</button><div><div class="ex-en">${esc(w.ex)}</div><div class="ex-ko">${esc(w.exKo || '')}</div></div></div>` : ''}
        ${w.tip ? `<div class="note">💡 ${esc(w.tip)}</div>` : ''}
      </div>
    </div>
    <button class="wknown ${known ? 'on' : ''}" data-wknown="${esc(key)}" title="외웠어요">${known ? '✔ 외움' : '외웠어요'}</button>
    ${starBtn(key)}
  </div>`;
}
function viewWords() {
  const total = D.decks.reduce((s, d) => s + d.words.length, 0);
  const known = D.decks.reduce((s, d) => s + deckProgress(d).k, 0);
  const q = WS.q.trim().toLowerCase();
  let results = '';
  if (q) {
    const hits = [];
    for (const d of D.decks) d.words.forEach((w, i) => { if (w.en.toLowerCase().includes(q) || String(w.ko).includes(q)) hits.push(wordRow(d, w, i, { showDeck: true })); });
    results = `<div class="count">${hits.length}개${hits.length > 100 ? ' (앞의 100개만 표시)' : ''}</div><div class="wlist">${hits.slice(0, 100).join('') || '<div class="empty">찾는 단어가 없어요</div>'}</div>`;
  }
  return `<div class="wrap"><h1>🔤 단어장</h1>
    <p class="sub">숫자·날짜·날씨 같은 완전 기초부터 상황별 단어, 고급 어휘까지. 목록 → 플래시카드 → 퀴즈 → 타이핑 순서로 외워 보세요.</p>
    <div class="hero" style="margin-bottom:6px"><div class="stats">
      <div class="stat"><b>${D.decks.length}</b><span>단어장</span></div>
      <div class="stat"><b>${total}</b><span>전체 단어</span></div>
      <div class="stat"><b>${known}</b><span>외운 단어</span></div></div>
      <div style="flex:1;min-width:220px"><input class="search" id="wSearch" placeholder="단어 검색 (영어·한국어)" value="${esc(WS.q)}"></div></div>
    ${results}
    ${q ? '' : DECK_GROUPS.map((g) => {
      const list = D.decks.filter((d) => (d.group || 'theme') === g.id);
      return list.length ? `<h2>${g.name} <span class="sub" style="font-size:13px;font-weight:400">${esc(g.desc)}</span></h2><div class="cards">${list.map(deckCard).join('')}</div>` : '';
    }).join('')}
    ${D.decks.length ? '' : '<div class="empty">단어장을 준비하고 있어요</div>'}
  </div>`;
}
function viewDeck() {
  const d = deckById(S.deckId);
  if (!d) return '<div class="empty">단어장을 찾을 수 없어요.</div>';
  const p = deckProgress(d);
  const tabs = [['list', '📋 단어 목록'], ['cards', '🃏 플래시카드'], ['quiz', '🧩 퀴즈'], ['typing', '⌨️ 타이핑']];
  let body = '';
  if (S.dtab === 'list') {
    const idx = deckIdx(d);
    body = `<div class="wlist ${store.ko ? '' : 'no-ko'}">${idx.map((i) => wordRow(d, d.words[i], i)).join('') || '<div class="empty">🎉 이 단어장은 다 외웠어요!</div>'}</div>`;
  } else if (S.dtab === 'cards') body = '<div id="fcBox"></div>';
  else if (S.dtab === 'quiz') body = '<div id="qzBox"></div>';
  else body = typingShell('deck:' + d.id);
  const i = D.decks.indexOf(d), prev = D.decks[i - 1], next = D.decks[i + 1];
  return `<div class="wrap">
    <div class="lesson-head"><div class="big">${d.emoji || '🔤'}</div>
      <div style="flex:1"><div>${lvChip(d.level)} <span class="chip">${esc((DECK_GROUPS.find((g) => g.id === d.group) || {}).name || '')}</span></div>
        <h1 style="margin-top:6px">${esc(d.name)}</h1><p class="sub" style="margin:0">${esc(d.nameEn || '')} · ${esc(d.desc || '')}</p></div>
      <div class="stat" style="text-align:right"><b>${p.k}/${p.n}</b><span>외운 단어</span></div></div>
    <div class="lesson-actions">
      <button class="btn primary" data-wact="playall">▶ 단어 전체 듣기</button>
      <button class="btn" data-act="stop">■ 멈춤</button>
      <label class="tg" style="margin-left:6px"><input type="checkbox" id="wOnly" ${WS.onlyUnknown ? 'checked' : ''}><span>안 외운 단어만</span></label>
      ${p.k ? '<button class="btn" data-wact="resetknown">외움 표시 초기화</button>' : ''}
    </div>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-dtab="${k}" class="${S.dtab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}
    <div class="lesson-actions" style="margin-top:24px; justify-content:space-between">
      ${prev ? `<button class="btn" data-deck="${esc(prev.id)}">← ${esc(prev.name)}</button>` : '<span></span>'}
      ${next ? `<button class="btn" data-deck="${esc(next.id)}">${esc(next.name)} →</button>` : ''}
    </div></div>`;
}
function openDeck(id) {
  stopAll();
  S.view = 'deck'; S.deckId = id; S.dtab = 'list'; S.sideMode = 'words';
  FC.deckId = null; QZ.deckId = null;
  render(); $('#main').scrollTop = 0;
}

// 플래시카드
const FC = { deckId: null, queue: [], pos: 0, flipped: false, front: 'en', good: 0, missed: new Set(), shuffle: true };
function fcStart() {
  const d = deckById(S.deckId);
  FC.deckId = d.id; FC.pos = 0; FC.flipped = false; FC.good = 0; FC.missed = new Set();
  FC.queue = FC.shuffle ? shuffle(deckIdx(d)) : deckIdx(d);
  fcRender(true);
}
function fcRender(autoplay) {
  const box = $('#fcBox'); if (!box) return;
  const d = deckById(S.deckId);
  if (FC.deckId !== d.id) return fcStart();
  const seg = `<div class="rp-setup"><span>앞면</span><div class="seg">
      <button data-fc="front-en" class="${FC.front === 'en' ? 'on' : ''}">영어</button><button data-fc="front-ko" class="${FC.front === 'ko' ? 'on' : ''}">한국어</button></div>
      <label class="tg"><input type="checkbox" data-fc="shuffle" ${FC.shuffle ? 'checked' : ''}><span>섞기</span></label>
      <button class="btn" data-fc="restart">⟳ 처음부터</button>
      <span class="rp-hint">Space 뒤집기 · ← 몰라요 · → 알아요 · ↑ 듣기</span></div>`;
  if (!FC.queue.length) { box.innerHTML = seg + '<div class="rp-stage"><div class="rp-ko">🎉 외울 단어가 없어요. "안 외운 단어만"을 끄면 전체를 볼 수 있어요.</div></div>'; return; }
  if (FC.pos >= FC.queue.length) {
    const p = deckProgress(d);
    box.innerHTML = seg + `<div class="rp-stage"><div class="rp-ko">🎉 한 바퀴 끝! 바로 안 단어 ${FC.good}개 · 다시 본 단어 ${FC.missed.size}개</div>
      <div class="rp-hint">이 단어장 외운 단어 ${p.k}/${p.n}</div>
      <div class="lesson-actions"><button class="btn primary" data-fc="restart">⟳ 한 바퀴 더</button>
      <button class="btn" data-dtab="quiz">🧩 퀴즈로 확인하기</button></div></div>`;
    return;
  }
  const w = d.words[FC.queue[FC.pos]];
  const front = FC.front === 'en'
    ? `<div class="fc-en">${esc(w.en)}</div>${w.ipa ? `<div class="ipa">${esc(w.ipa)}</div>` : ''}`
    : `<div class="fc-ko">${esc(w.ko)}</div>${w.pos ? `<div class="ipa">${esc(w.pos)}</div>` : ''}`;
  const back = `<div class="fc-back">
      ${FC.front === 'en' ? `<div class="fc-ko">${esc(w.ko)}</div>` : `<div class="fc-en">${esc(w.en)}</div>${w.ipa ? `<div class="ipa">${esc(w.ipa)}</div>` : ''}`}
      ${w.pos ? `<span class="pos">${esc(w.pos)}</span>` : ''}
      ${w.ex ? `<div class="ex" style="justify-content:center;margin-top:10px"><button class="play" data-wex="${esc(wKey(d, w))}">▶</button><div style="text-align:left"><div class="ex-en">${esc(w.ex)}</div><div class="ex-ko">${esc(w.exKo || '')}</div></div></div>` : ''}
      ${w.tip ? `<div class="note">💡 ${esc(w.tip)}</div>` : ''}</div>`;
  box.innerHTML = seg + `<div class="fc-count">${FC.pos + 1} / ${FC.queue.length}</div>
    <div class="fc-card ${FC.flipped ? 'flipped' : ''}" data-fc="flip">${front}${FC.flipped ? back : '<div class="rp-hint" style="margin-top:14px">눌러서 뒤집기</div>'}</div>
    <div class="fc-actions">
      <button class="btn fc-no" data-fc="no">← 몰라요</button>
      <button class="btn" data-fc="play">🔊 듣기</button>
      <button class="btn fc-yes" data-fc="yes">알아요 →</button></div>`;
  box.scrollIntoView({ block: 'start' }); // 작은 화면에서도 카드와 버튼이 보이게
  if (autoplay && (FC.front === 'en' || FC.flipped)) playClip(w.audio, w.say || w.en);
}
function fcAction(a, t) {
  const d = deckById(S.deckId);
  if (a === 'front-en' || a === 'front-ko') { FC.front = a.slice(6); FC.flipped = false; return fcRender(true); }
  if (a === 'shuffle') { FC.shuffle = t.checked; return fcStart(); }
  if (a === 'restart') return fcStart();
  if (FC.pos >= FC.queue.length) return;
  const w = d.words[FC.queue[FC.pos]];
  if (a === 'play') return playClip(w.audio, w.say || w.en);
  if (a === 'flip') { FC.flipped = !FC.flipped; return fcRender(FC.flipped && FC.front === 'ko'); }
  if (a === 'yes') { if (!FC.missed.has(FC.queue[FC.pos])) FC.good++; setKnown(wKey(d, w), true); }
  if (a === 'no') {
    FC.missed.add(FC.queue[FC.pos]); setKnown(wKey(d, w), false);
    FC.queue.splice(Math.min(FC.queue.length, FC.pos + 4), 0, FC.queue[FC.pos]); // 몇 장 뒤에 다시
  }
  if (a === 'yes' || a === 'no') { FC.pos++; FC.flipped = false; renderSide(); fcRender(true); }
}

// 4지선다 퀴즈
const QZ = { deckId: null, dir: 'en2ko', items: [], i: 0, choices: [], picked: null, score: 0, wrong: [] };
function qzStart() {
  const d = deckById(S.deckId);
  QZ.deckId = d.id; QZ.i = 0; QZ.score = 0; QZ.wrong = []; QZ.picked = null;
  QZ.items = shuffle(deckIdx(d)).slice(0, 20);
  qzMake(); qzRender();
}
function qzMake() {
  const d = deckById(QZ.deckId);
  if (QZ.i >= QZ.items.length) return;
  const ans = QZ.items[QZ.i];
  const field = QZ.dir === 'ko2en' ? 'en' : 'ko';
  const others = shuffle(d.words.map((w, i) => i).filter((i) => i !== ans && d.words[i][field] !== d.words[ans][field])).slice(0, 3);
  QZ.choices = shuffle([ans, ...others]);
  QZ.picked = null;
}
function qzRender() {
  const box = $('#qzBox'); if (!box) return;
  const d = deckById(S.deckId);
  if (QZ.deckId !== d.id) return qzStart();
  const seg = `<div class="rp-setup"><span>문제</span><div class="seg">
      ${[['en2ko', '영어 → 뜻'], ['ko2en', '뜻 → 영어'], ['listen', '듣고 뜻 고르기']].map(([k, n]) => `<button data-qz="dir-${k}" class="${QZ.dir === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <button class="btn" data-qz="restart">⟳ 새 문제</button><span class="rp-hint">숫자키 1~4 선택 · Enter 다음</span></div>`;
  if (!QZ.items.length) { box.innerHTML = seg + '<div class="rp-stage"><div class="rp-ko">문제를 낼 단어가 없어요.</div></div>'; return; }
  if (QZ.i >= QZ.items.length) {
    box.innerHTML = seg + `<div class="rp-stage"><div class="rp-ko">${QZ.score === QZ.items.length ? '🏆' : '👍'} ${QZ.score} / ${QZ.items.length} 정답</div>
      <div class="lesson-actions"><button class="btn primary" data-qz="restart">⟳ 새 문제 20개</button>
      ${QZ.wrong.length ? '<button class="btn" data-qz="starwrong">☆ 틀린 단어 복습함에 담기</button>' : ''}</div></div>
      ${QZ.wrong.length ? `<h2>틀린 단어</h2><div class="wlist">${QZ.wrong.map((i) => wordRow(d, d.words[i], i)).join('')}</div>` : ''}`;
    return;
  }
  const w = d.words[QZ.items[QZ.i]];
  const q = QZ.dir === 'en2ko' ? `<div class="fc-en">${esc(w.en)}</div>${w.ipa ? `<div class="ipa">${esc(w.ipa)}</div>` : ''}`
    : QZ.dir === 'ko2en' ? `<div class="fc-ko">${esc(w.ko)}</div>` : '<div class="fc-ko">🎧 잘 듣고 뜻을 고르세요</div>';
  box.innerHTML = seg + `<div class="fc-count">${QZ.i + 1} / ${QZ.items.length} · 정답 ${QZ.score}</div>
    <div class="rp-stage qz-stage" style="text-align:center">${q}
      ${QZ.dir !== 'ko2en' ? '<button class="tool" data-qz="play">🔊 다시 듣기</button>' : ''}
      <div class="qz-choices">${QZ.choices.map((ci, n) => {
        const c = d.words[ci];
        const cls = QZ.picked == null ? '' : ci === QZ.items[QZ.i] ? 'right' : ci === QZ.picked ? 'wrong' : 'dim';
        return `<button class="qz-opt ${cls}" data-qz="pick-${ci}"><b>${n + 1}</b> ${esc(QZ.dir === 'ko2en' ? c.en : c.ko)}</button>`;
      }).join('')}</div>
      ${QZ.picked != null ? `<div class="qz-after">${QZ.picked === QZ.items[QZ.i] ? '⭕ 정답!' : '❌ 정답은 위 초록색이에요'} ·
        <b>${esc(w.en)}</b> = ${esc(w.ko)}${w.ex ? `<div class="ex-en" style="margin-top:6px">${esc(w.ex)}</div><div class="ex-ko">${esc(w.exKo || '')}</div>` : ''}
        <div style="margin-top:10px"><button class="btn primary" data-qz="next">${QZ.i + 1 < QZ.items.length ? '다음 →' : '결과 보기'}</button></div></div>` : ''}
    </div>`;
  box.querySelector('.qz-after')?.scrollIntoView({ block: 'nearest' }) || (QZ.picked == null && box.scrollIntoView({ block: 'start' }));
  if (QZ.picked == null && QZ.dir !== 'ko2en') playClip(w.audio, w.say || w.en);
}
function qzAction(a) {
  const d = deckById(S.deckId);
  if (a.startsWith('dir-')) { QZ.dir = a.slice(4); return qzStart(); }
  if (a === 'restart') return qzStart();
  if (a === 'starwrong') { QZ.wrong.forEach((i) => { store.stars[wKey(d, d.words[i])] ||= Date.now(); }); save(); renderSide(); return; }
  const w = d.words[QZ.items[QZ.i]];
  if (a === 'play') return playClip(w.audio, w.say || w.en);
  if (a.startsWith('pick-') && QZ.picked == null) {
    QZ.picked = Number(a.slice(5));
    if (QZ.picked === QZ.items[QZ.i]) QZ.score++; else QZ.wrong.push(QZ.items[QZ.i]);
    qzRender(); playClip(w.audio, w.say || w.en); return;
  }
  if (a === 'next' && QZ.picked != null) { QZ.i++; qzMake(); qzRender(); }
}

// ================= 공용 연습문제 엔진 (문법 연습·독해 문제·작문 드릴) =================
// 문제 형식: choice(고르기) · order(단어 배열) · fix(틀린 곳 고치기) · write(영작)
const GX = { src: null, items: [], idx: 0, phase: 'setup', results: [], typed: '', built: [], pool: [], title: '' };
function gxShell(src, items, title) {
  if (GX.src !== src) { Object.assign(GX, { src, items, idx: 0, phase: 'setup', results: [], typed: '', built: [], pool: [], title }); }
  else GX.items = items;
  return '<div id="gxBox"></div>';
}
function gxStart(items) {
  stopAll();
  if (items) GX.items = items;
  GX.idx = 0; GX.results = []; GX.phase = GX.items.length ? 'q' : 'setup';
  gxPrep(); gxRender();
}
function gxPrep() {
  const it = GX.items[GX.idx]; if (!it) return;
  GX.typed = it.type === 'fix' ? it.wrong : '';
  GX.built = []; GX.pool = it.type === 'order' ? shuffle(it.words.map((w, i) => ({ w, i }))) : [];
  GX.picked = null;
}
const gxAnswers = (it) => [it.answer, ...(it.alts || [])].filter(Boolean);
function gxCheck() {
  const it = GX.items[GX.idx];
  let ok = false;
  if (it.type === 'choice') ok = GX.picked === it.answer;
  else if (it.type === 'order') { GX.typed = GX.built.map((b) => b.w).join(' '); ok = normFull(GX.typed) === normFull(it.answer); }
  else { GX.typed = ($('#gxInput') || {}).value ?? GX.typed; ok = gxAnswers(it).some((a) => normFull(a) === normFull(GX.typed)); }
  if (!GX.results[GX.idx]) GX.results[GX.idx] = { ok, typed: GX.typed };
  GX.phase = ok ? 'right' : 'wrong';
  gxRender();
  const say = it.full || (it.type !== 'choice' ? it.answer : null);
  if (it.audio && say) playClip(it.audio, say);
}
function gxNext() {
  stopAll();
  if (GX.idx + 1 >= GX.items.length) {
    GX.phase = 'done';
    const ok = GX.results.filter((r) => r && r.ok).length, score = Math.round((ok / GX.items.length) * 100);
    store.gx ||= {};
    if (store.gx[GX.src] == null || score > store.gx[GX.src]) { store.gx[GX.src] = score; save(); }
    renderSide();
  } else { GX.idx++; GX.phase = 'q'; gxPrep(); }
  gxRender();
}
function gxRender() {
  const box = $('#gxBox'); if (!box) return;
  const best = (store.gx || {})[GX.src];
  const head = `<div class="rp-setup"><button class="btn primary" data-gx="start">${GX.phase === 'setup' ? '✏️ 문제 풀기 시작' : '⟳ 처음부터'}</button>
    <span class="rp-hint">${GX.items.length}문제${best != null ? ` · 최고 ${best}점` : ''} · Enter 확인·다음${GX.items.some((x) => x.type === 'choice') ? ' · 숫자키로 선택' : ''}</span></div>`;
  if (GX.phase === 'setup') { box.innerHTML = head; return; }
  if (GX.phase === 'done') {
    const ok = GX.results.filter((r) => r && r.ok).length, n = GX.items.length, score = Math.round((ok / n) * 100);
    const wrong = GX.items.map((it, i) => ({ it, r: GX.results[i] })).filter((x) => !x.r || !x.r.ok);
    box.innerHTML = head + `<div class="rp-stage"><div class="rp-ko">${score >= 80 ? '🏆' : score >= 50 ? '👍' : '💪'} ${ok} / ${n} 정답 · ${score}점</div>
      ${score >= 80 ? '<div class="rp-hint">80점 이상이면 완료(✅)로 표시돼요.</div>' : '<div class="rp-hint">80점 이상이면 완료로 표시돼요. 틀린 문제만 다시 풀어 보세요.</div>'}
      ${wrong.length ? `<div class="lesson-actions"><button class="btn primary" data-gx="retrywrong">✍️ 틀린 ${wrong.length}문제만 다시</button></div>` : ''}</div>
      ${wrong.length ? `<h2>다시 볼 문제</h2><div class="phr">${wrong.map(({ it }) => `<div class="phr-item"><span></span><div>
        <div class="en">${esc(it.full || it.answer || (it.options ? it.options[it.answer] : ''))}</div>
        <div class="ko">${esc(it.ko || it.q || '')}</div>${it.why ? `<div class="note">💡 ${esc(it.why)}</div>` : ''}</div><span></span></div>`).join('')}</div>` : ''}`;
    return;
  }
  const it = GX.items[GX.idx];
  const checked = GX.phase !== 'q';
  const typeName = { choice: '알맞은 것 고르기', order: '단어 배열하기', fix: '틀린 곳 고치기', write: '영어로 쓰기' }[it.type] || '';
  let body = '';
  if (it.type === 'choice') {
    body = `<div class="gx-q">${esc(it.q).replace(/_{2,}/g, '<span class="gx-blank">____</span>')}</div>${it.ko ? `<div class="rp-hint">${esc(it.ko)}</div>` : ''}
      <div class="qz-choices">${it.options.map((o, i) => {
        const cls = !checked ? (GX.picked === i ? 'sel' : '') : i === it.answer ? 'right' : i === GX.picked ? 'wrong' : 'dim';
        return `<button class="qz-opt ${cls}" data-gx="pick-${i}"><b>${i + 1}</b> ${esc(o)}</button>`;
      }).join('')}</div>`;
  } else if (it.type === 'order') {
    body = `<div class="rp-ko">${esc(it.ko || '')}</div>
      <div class="gx-built">${GX.built.map((b, k) => `<button class="chipw on" data-gx="unpick-${k}">${esc(b.w)}</button>`).join('') || '<span class="rp-hint">아래 단어를 순서대로 누르세요</span>'}</div>
      <div class="gx-pool">${GX.pool.map((p, k) => `<button class="chipw" data-gx="take-${k}" ${checked ? 'disabled' : ''}>${esc(p.w)}</button>`).join('')}</div>`;
  } else {
    body = `${it.type === 'fix' ? `<div class="rp-hint">틀린 부분을 고쳐서 문장 전체를 다시 쓰세요</div><div class="gx-q gx-wrong">${esc(it.wrong)}</div>` : ''}
      <div class="rp-ko">${esc(it.ko || '')}</div>${it.hint && !checked ? `<div class="rp-hint">💡 힌트: ${esc(it.hint)}</div>` : ''}
      <input id="gxInput" class="search ty-input" autocomplete="off" spellcheck="false" placeholder="영어로 입력하고 Enter" ${checked ? 'readonly' : ''} value="${esc(GX.typed)}">
      <div class="ty-warn" id="gxWarn" hidden>⚠️ 한글로 입력되고 있어요. 한/영 키를 눌러 주세요.</div>`;
  }
  const res = GX.results[GX.idx];
  const answerText = it.type === 'choice' ? (it.full || it.options[it.answer]) : it.answer;
  box.innerHTML = head + `<div class="rp-stage ty-stage ${checked ? GX.phase : ''}">
    <div class="rp-cue">${GX.idx + 1} / ${GX.items.length} · ${typeName}</div>
    ${body}
    <div class="tools" style="margin-top:10px">
      ${!checked ? `<button class="tool" data-gx="check">✔ 확인</button>${it.type === 'order' ? '<button class="tool" data-gx="clear">↺ 다시 배열</button>' : ''}<button class="tool" data-gx="skip">모르겠어요</button>`
        : `<button class="tool" data-gx="next">${GX.idx + 1 < GX.items.length ? '다음 →' : '결과 보기'}</button>${it.audio ? '<button class="tool" data-gx="play">🔊 듣기</button>' : ''}`}
    </div>
    ${checked ? `<div class="ty-result"><div class="ty-verdict">${GX.phase === 'right' ? (res && res.ok ? '⭕ 정답!' : '⭕ 맞았어요') : '❌ 아쉬워요'}</div>
      ${it.type === 'choice' ? `<div class="ty-line"><span class="ty-label">정답</span> <b>${esc(answerText)}</b></div>`
        : `<div class="ty-line"><span class="ty-label">정답</span> ${GX.phase === 'wrong' ? wordDiff(answerText, GX.typed || '').answer : esc(answerText)}</div>
           ${GX.phase === 'wrong' && GX.typed ? `<div class="ty-line"><span class="ty-label">내 답</span> ${wordDiff(answerText, GX.typed).mine}</div>` : ''}
           ${(it.alts || []).length ? `<div class="note">이렇게 써도 정답: ${it.alts.map(esc).join(' / ')}</div>` : ''}`}
      ${it.why ? `<div class="exp">${esc(it.why)}</div>` : ''}</div>` : ''}
  </div>`;
  box.querySelector('.ty-stage').scrollIntoView({ block: 'nearest' });
  const inp = $('#gxInput');
  if (inp) {
    inp.focus({ preventScroll: true });
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener('input', () => { GX.typed = inp.value; $('#gxWarn').hidden = !/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(inp.value); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); GX.phase === 'q' ? gxCheck() : gxNext(); } });
  }
}
function gxAction(a) {
  const it = GX.items[GX.idx];
  if (a === 'start') return gxStart();
  if (a === 'retrywrong') return gxStart(GX.items.filter((x, i) => !GX.results[i] || !GX.results[i].ok));
  if (a === 'next') return gxNext();
  if (a === 'play') { const say = it.full || it.answer; if (it.audio) playClip(it.audio, say); return; }
  if (GX.phase !== 'q') return;
  if (a === 'check') { if (it.type === 'choice' && GX.picked == null) return; return gxCheck(); }
  if (a === 'skip') { GX.results[GX.idx] = GX.results[GX.idx] || { ok: false, typed: GX.typed }; GX.phase = 'wrong'; gxRender(); if (it.audio) playClip(it.audio, it.full || it.answer); return; }
  if (a.startsWith('pick-')) { GX.picked = Number(a.slice(5)); return gxCheck(); }
  if (a.startsWith('take-')) { GX.built.push(...GX.pool.splice(Number(a.slice(5)), 1)); if (!GX.pool.length) return gxCheck(); return gxRender(); }
  if (a.startsWith('unpick-')) { GX.pool.push(...GX.built.splice(Number(a.slice(7)), 1)); return gxRender(); }
  if (a === 'clear') { GX.pool.push(...GX.built); GX.built = []; return gxRender(); }
}
const gxDone = (src) => ((store.gx || {})[src] ?? -1) >= 80 || (src.startsWith('X:') && !!(store.xdone || {})[src.slice(2)]) || (src.startsWith('W:') && !!(store.wdone || {})[src.slice(2)]);

// ================= 학습 코너 공통 =================
function cornerCard(kind, it, src) {
  const best = (store.gx || {})[src];
  return `<button class="card" data-${kind}="${esc(it.id)}">
    <div class="em">${it.emoji || '📘'}</div>
    <div class="ct">${esc(it.title)} ${gxDone(src) ? '✅' : ''}</div>
    <div class="cd">${esc(it.titleEn || '')}</div>
    <div style="margin-top:6px">${lvChip(it.level)} ${it.type ? `<span class="chip">${esc(it.type)}</span>` : ''}${best != null ? ` <span class="rp-hint">${best}점</span>` : ''}</div></button>`;
}
function cornerHead(it, src) {
  const best = (store.gx || {})[src];
  return `<div class="lesson-head"><div class="big">${it.emoji || '📘'}</div>
    <div style="flex:1"><div>${lvChip(it.level)} ${it.type ? `<span class="chip">${esc(it.type)}</span>` : ''} ${it.theme === 'story' ? '<span class="chip">📖 이야기·교훈</span>' : ''}</div>
      <h1 style="margin-top:6px">${esc(it.title)}</h1><p class="sub" style="margin:0">${esc(it.titleEn || '')}${it.summary || it.intro || it.prompt ? ' · ' + esc(it.summary || it.intro || '') : ''}</p></div>
    ${best != null ? `<div class="stat" style="text-align:right"><b>${best}점</b><span>${gxDone(src) ? '✅ 완료' : '최고 점수'}</span></div>` : ''}</div>`;
}
function cornerNav(list, cur, kind) {
  const i = list.indexOf(cur), prev = list[i - 1], next = list[i + 1];
  return `<div class="lesson-actions" style="margin-top:24px; justify-content:space-between">
    ${prev ? `<button class="btn" data-${kind}="${esc(prev.id)}">← ${esc(prev.title)}</button>` : '<span></span>'}
    ${next ? `<button class="btn" data-${kind}="${esc(next.id)}">${esc(next.title)} →</button>` : ''}</div>`;
}
const exRow = (x, key) => `<div class="ex"><button class="play" data-cplay="${esc(key)}">▶</button><div><div class="ex-en">${esc(x.en)}</div><div class="ex-ko">${esc(x.ko || '')}</div>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</div></div>`;
// 재생 키 → 항목 (코너 공용)
const CPLAY = new Map();
const reg = (key, item) => { CPLAY.set(key, item); return key; };

// ---- 📐 문법 ----
function viewGrammar() {
  return `<div class="wrap"><h1>📐 문법</h1><p class="sub">회화에 꼭 필요한 문법만, 완전 기초부터 고급까지. 단원마다 설명 → 연습문제 순서로 공부해요.</p>
    ${LEVEL_ORDER.map((lv) => { const list = D.grammar.filter((u) => u.level === lv); return list.length ? `<h2>${lvChip(lv)}</h2><div class="cards">${list.map((u) => cornerCard('gunit', u, 'G:' + u.id)).join('')}</div>` : ''; }).join('')}
    ${D.grammar.length ? '' : '<div class="empty">문법 단원을 준비하고 있어요</div>'}</div>`;
}
function viewGrammarUnit() {
  const u = D.grammar.find((x) => x.id === S.cornerId); if (!u) return '<div class="empty">단원을 찾을 수 없어요</div>';
  const src = 'G:' + u.id;
  const tabs = [['learn', '📖 설명'], ['practice', `✏️ 연습문제 (${(u.exercises || []).length})`]];
  let body;
  if (S.ctab === 'practice') body = gxShell(src, u.exercises || []);
  else body = `${(u.sections || []).map((s, si) => `<div class="point"><h3>📌 ${esc(s.title)}</h3><p>${esc(s.body)}</p>
      ${s.table ? `<table class="gtable"><thead><tr>${s.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
      ${(s.examples || []).map((x, xi) => exRow(x, reg(`g:${u.id}:${si}:${xi}`, x))).join('')}
      ${(s.moreExamples || []).length ? `<div class="gmore"><div class="gmore-h">➕ 예문 더 보기</div>${s.moreExamples.map((x, xi) => exRow(x, reg(`gx:${u.id}:${si}:${xi}`, x))).join('')}</div>` : ''}</div>`).join('')}
    ${(u.dialogue || []).length ? `<div class="point"><h3>💬 회화 속 문법 <button class="btn" data-gdlg="${esc(u.id)}">▶ 대화 듣기</button></h3>${u.dialogueNote ? `<p class="rp-hint">${esc(u.dialogueNote)}</p>` : ''}
      <div class="gdlg">${u.dialogue.map((x, xi) => `<div class="gdl ${x.s === 'B' ? 'b' : ''}" data-gdl="${xi}"><span class="gwho">${esc(x.s)}</span>${exRow(x, reg(`gd:${u.id}:${xi}`, x))}</div>`).join('')}</div></div>` : ''}
    ${(u.mistakes || []).length ? `<div class="point"><h3>⚠️ 틀리기 쉬운 것</h3>${u.mistakes.map((m, mi) => `<div class="gm">
      <div><span class="gm-wrong">✗ ${esc(m.wrong)}</span></div><div class="ex"><button class="play" data-cplay="${esc(reg(`gm:${u.id}:${mi}`, { en: m.right, audio: m.audio }))}">▶</button><div><span class="gm-right">✓ ${esc(m.right)}</span><div class="note">${esc(m.why)}</div></div></div></div>`).join('')}</div>` : ''}
    ${u.tips ? `<div class="point culture"><h3>🗣 회화에서는</h3><p>${esc(u.tips)}</p></div>` : ''}
    <div class="lesson-actions"><button class="btn primary" data-ctab="practice">✏️ 연습문제 풀러 가기</button></div>`;
  return `<div class="wrap">${cornerHead(u, src)}
    <div class="tabs">${tabs.map(([k, n]) => `<button data-ctab="${k}" class="${(S.ctab || 'learn') === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}${cornerNav(D.grammar, u, 'gunit')}</div>`;
}

// ---- 📰 독해 ----
const RS = { open: new Set(), allKo: false };
function viewReading() {
  const stories = D.reading.filter((r) => r.theme === 'story');
  const rest = D.reading.filter((r) => r.theme !== 'story');
  return `<div class="wrap"><h1>📰 독해 연습</h1><p class="sub">표지판·메뉴·문자부터 이메일·기사·칼럼, 우화·단편·교훈 이야기까지. 문장을 누르면 발음과 해석이 나와요.</p>
    <div class="lesson-actions"><label class="tg"><input type="checkbox" id="readKo" ${store.readKo ? 'checked' : ''}><span>연속 듣기 때 한국어 해석도 읽어 주기</span></label><button class="btn" data-act="stop">■ 멈춤</button></div>
    ${stories.length ? `<h2>📖 이야기·교훈 <button class="btn" data-rbook="${stories.map((r) => r.id).join(',')}">🎧 연속 듣기</button></h2><div class="cards">${stories.map((r) => cornerCard('rpass', r, 'R:' + r.id)).join('')}</div>` : ''}
    ${LEVEL_ORDER.map((lv) => { const list = rest.filter((r) => r.level === lv); return list.length ? `<h2>${lvChip(lv)} 생활 독해 <button class="btn" data-rbook="${list.map((r) => r.id).join(',')}">🎧 연속 듣기</button></h2><div class="cards">${list.map((r) => cornerCard('rpass', r, 'R:' + r.id)).join('')}</div>` : ''; }).join('')}
    ${D.reading.length ? '' : '<div class="empty">독해 지문을 준비하고 있어요</div>'}</div>`;
}
function viewReadingPassage() {
  const r = D.reading.find((x) => x.id === S.cornerId); if (!r) return '<div class="empty">지문을 찾을 수 없어요</div>';
  const src = 'R:' + r.id;
  const tabs = [['text', '📖 본문'], ['vocab', `🔤 단어 (${(r.vocab || []).length})`], ...((r.patterns || []).length ? [['patterns', `🧩 핵심 구문 (${r.patterns.length})`]] : []), ['quiz', `❓ 문제 (${(r.questions || []).length})`]];
  let body;
  if (S.ctab === 'vocab') body = `<div class="wlist">${(r.vocab || []).map((v, i) => `<div class="wrow"><button class="play" data-cplay="${esc(reg(`rv:${r.id}:${i}`, v))}">▶</button>
      <div class="wmain"><span class="wen">${esc(v.en)}</span><div class="wko">${esc(v.ko)}</div>${v.note ? `<div class="note">💡 ${esc(v.note)}</div>` : ''}
      ${(v.examples || []).length ? `<div class="wex">${v.examples.map((e, ei) => exRow(e, reg(`rve:${r.id}:${i}:${ei}`, e))).join('')}</div>` : ''}</div><span></span><span></span></div>`).join('')}</div>`;
  else if (S.ctab === 'patterns') body = (r.patterns || []).map((pt, pi) => `<div class="point"><h3>🧩 ${esc(pt.pattern)}</h3>
      ${pt.from ? `<div class="rp-hint" style="margin-bottom:4px">본문에서</div>${exRow({ en: pt.from, ko: '' }, reg(`rpf:${r.id}:${pi}`, { en: pt.from, audio: pt.fromAudio }))}` : ''}
      <p style="margin:8px 0">${esc(pt.ko || '')}</p>
      <div class="gmore"><div class="gmore-h">➕ 같은 구조로 만든 예문</div>${(pt.examples || []).map((e, ei) => exRow(e, reg(`rpe:${r.id}:${pi}:${ei}`, e))).join('')}</div></div>`).join('');
  else if (S.ctab === 'quiz') {
    body = gxShell(src, (r.questions || []).map((q) => ({ type: 'choice', q: q.q, options: q.options, answer: q.answer, why: q.why })));
    if (gxDone(src) || GX.phase === 'done') body += `<div class="point culture" style="margin-top:16px"><h3>📝 요약</h3><p>${esc(r.summary || '')}</p>${r.lesson ? `<p style="margin-top:8px"><b>교훈</b> ${esc(r.lesson)}</p>` : ''}</div>`;
  } else {
    body = `<div class="lesson-actions" style="margin-top:0"><button class="btn primary" data-ract="playall">▶ 본문 듣기</button>
        <button class="btn ${RS.repeat ? 'on' : ''}" data-ract="repeat">🔁 반복${RS.repeat ? ' 켜짐' : ''}</button>
        <label class="tg"><input type="checkbox" id="readKo" ${store.readKo ? 'checked' : ''}><span>해석도 읽어 주기</span></label>
        <button class="btn" data-act="stop">■ 멈춤</button>
        <button class="btn ${RS.allKo ? 'on' : ''}" data-ract="allko">${RS.allKo ? '해석 숨기기' : '해석 모두 보기'}</button>
        <span class="rp-hint">문장을 누르면 발음 + 해석</span></div>
      <div class="reading ${RS.allKo ? 'all-ko' : ''}">${(r.paragraphs || []).map((para, pi) => `<p class="rpara">${para.map((s, si) => {
        const k = reg(`rs:${r.id}:${pi}:${si}`, s); const open = RS.allKo || RS.open.has(k);
        return `<span class="rs ${open ? 'open' : ''}" data-rs="${esc(k)}">${esc(s.en)}</span>${open ? `<span class="rs-ko">${esc(s.ko)}${s.note ? `<span class="rs-note">💡 ${esc(s.note)}</span>` : ''}</span>` : ''} `;
      }).join('')}</p>`).join('')}</div>
      <div class="lesson-actions"><button class="btn primary" data-ctab="quiz">❓ 내용 확인 문제 풀기</button><button class="btn" data-ctab="vocab">🔤 단어 보기</button></div>`;
  }
  return `<div class="wrap">${cornerHead(r, src)}
    <div class="tabs">${tabs.map(([k, n]) => `<button data-ctab="${k}" class="${(S.ctab || 'text') === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}${cornerNav(D.reading, r, 'rpass')}</div>`;
}

// 오디오북: 지문 목록을 차례로 읽어 준다 (해석 읽기·반복 지원). 지문이 바뀌면 화면도 따라간다.
async function audiobook(ids, { repeat = false } = {}) {
  stopAll();
  const token = ++playToken;
  do {
    for (const id of ids) {
      const r = D.reading.find((x) => x.id === id); if (!r) continue;
      if (S.view !== 'rpass' || S.cornerId !== id) {
        S.view = 'rpass'; S.cornerId = id; S.ctab = 'text'; S.sideMode = 'rpass'; RS.open = new Set();
        render(); $('#main').scrollTop = 0;
      } else if (S.ctab && S.ctab !== 'text') { S.ctab = 'text'; rerender(); }
      setNow('🎧 ' + r.title);
      for (let pi = 0; pi < (r.paragraphs || []).length; pi++) {
        for (let si = 0; si < r.paragraphs[pi].length; si++) {
          if (token !== playToken) return;
          const s = r.paragraphs[pi][si];
          const sel = `[data-rs="${CSS.escape(`rs:${r.id}:${pi}:${si}`)}"]`;
          markRow(document.querySelector(sel));
          await playClip(s.audio, s.en);
          if (token !== playToken) return;
          if (store.readKo) { await sleep(250); await playClip(s.koAudio, s.ko, 'ko-KR'); }
          await sleep(350);
        }
        await sleep(400);
      }
      markRow(null);
      if (ids.length > 1) await sleep(1500);
    }
  } while (repeat && token === playToken);
  if (token === playToken) { markRow(null); setNow(''); }
}

// ---- ✍️ 작문 ----
function viewWriting() {
  return `<div class="wrap"><h1>✍️ 작문 연습</h1><p class="sub">핵심 표현 익히기 → 문장 드릴(자동 채점) → 직접 써 보기 → 모범 답안과 비교·자가 점검.</p>
    ${LEVEL_ORDER.map((lv) => { const list = D.writing.filter((w) => w.level === lv); return list.length ? `<h2>${lvChip(lv)}</h2><div class="cards">${list.map((w) => cornerCard('wtask', w, 'W:' + w.id)).join('')}</div>` : ''; }).join('')}
    ${D.writing.length ? '' : '<div class="empty">작문 과제를 준비하고 있어요</div>'}</div>`;
}
function exprUsed(text, en) {
  const core = en.toLowerCase().replace(/~|\(.*?\)|\[.*?\]/g, ' ').split(/[\/,]/)[0].replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
  return core && text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').includes(core);
}
function viewWritingTask() {
  const w = D.writing.find((x) => x.id === S.cornerId); if (!w) return '<div class="empty">과제를 찾을 수 없어요</div>';
  const src = 'W:' + w.id;
  const tabs = [['task', '✏️ 과제'], ['drill', `🧩 문장 드릴 (${(w.drills || []).length})`], ['model', '📄 모범 답안']];
  store.wdraft ||= {}; store.wcheck ||= {};
  const draft = store.wdraft[w.id] || '';
  let body;
  if (S.ctab === 'drill') body = gxShell(src, (w.drills || []).map((d) => ({ type: 'write', ...d })));
  else if (S.ctab === 'model') {
    body = `<div class="lesson-actions" style="margin-top:0"><button class="btn primary" data-wtact="playmodel">▶ 모범 답안 듣기</button><button class="btn" data-act="stop">■ 멈춤</button></div>
      <div class="point">${(w.model || []).map((x, i) => exRow(x, reg(`wm:${w.id}:${i}`, x))).join('')}</div>
      ${(w.mistakes || []).length ? `<div class="point"><h3>⚠️ 자주 하는 실수</h3>${w.mistakes.map((m) => `<div class="gm"><div><span class="gm-wrong">✗ ${esc(m.wrong)}</span></div><div><span class="gm-right">✓ ${esc(m.right)}</span><div class="note">${esc(m.why)}</div></div></div>`).join('')}</div>` : ''}`;
  } else {
    const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
    const sents = (draft.match(/[.!?](\s|$)/g) || []).length;
    const checks = store.wcheck[w.id] || [];
    body = `<div class="point"><h3>📝 과제</h3><p>${esc(w.prompt)}</p><p class="rp-hint" style="margin-top:6px">분량: ${esc(w.target || '')}</p>
        ${(w.structure || []).length ? `<div class="wstruct">${w.structure.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ')}</div>` : ''}</div>
      <h2>🔑 써먹을 표현</h2>
      <div class="wlist">${(w.expressions || []).map((x, i) => `<div class="wrow ${exprUsed(draft, x.en) ? 'used' : ''}"><button class="play" data-cplay="${esc(reg(`we:${w.id}:${i}`, x))}">▶</button>
        <div class="wmain"><span class="wen">${esc(x.en)}</span> ${exprUsed(draft, x.en) ? '<span class="pos">✔ 사용함</span>' : ''}<div class="wko">${esc(x.ko)}</div>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}
        ${(x.examples || []).length ? `<div class="wex">${x.examples.map((e, ei) => exRow(e, reg(`wx:${w.id}:${i}:${ei}`, e))).join('')}</div>` : ''}</div><span></span><span></span></div>`).join('')}</div>
      <h2>✍️ 직접 써 보기</h2>
      <textarea id="wDraft" class="wdraft" spellcheck="false" placeholder="여기에 영어로 써 보세요. 자동으로 저장돼요.">${esc(draft)}</textarea>
      <div class="rp-hint" id="wCount">${words}단어 · ${sents}문장</div>
      <div class="lesson-actions"><button class="btn primary" data-wtact="compare">📄 다 썼어요 → 모범 답안과 비교</button></div>
      ${S.wCompare ? `<div class="wcompare"><div class="point"><h3>내 글</h3><p>${esc(draft) || '<span class="rp-hint">아직 쓴 내용이 없어요</span>'}</p></div>
        <div class="point"><h3>모범 답안</h3>${(w.model || []).map((x, i) => exRow(x, reg(`wm:${w.id}:${i}`, x))).join('')}</div></div>
        <div class="point culture"><h3>✅ 스스로 점검하기</h3>${(w.checklist || []).map((c, i) => `<label class="tg wcheck"><input type="checkbox" data-wcheck="${i}" ${checks[i] ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
          <div class="lesson-actions"><button class="btn" data-wtact="done">${gxDone(src) ? '✅ 완료됨' : '☐ 이 과제 완료 표시'}</button></div></div>` : ''}`;
  }
  return `<div class="wrap">${cornerHead(w, src)}
    <div class="tabs">${tabs.map(([k, n]) => `<button data-ctab="${k}" class="${(S.ctab || 'task') === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}${cornerNav(D.writing, w, 'wtask')}</div>`;
}

function openCorner(view, id) {
  stopAll();
  S.view = view; S.cornerId = id; S.ctab = null; S.wCompare = false; RS.open = new Set(); RS.allKo = false;
  S.sideMode = view;
  render(); $('#main').scrollTop = 0;
}
function renderSideCorner() {
  const kind = { gunit: 'gunit', rpass: 'rpass', wtask: 'wtask' }[S.sideMode];
  const list = S.sideMode === 'gunit' ? D.grammar : S.sideMode === 'rpass' ? D.reading : D.writing;
  const pre = { gunit: 'G:', rpass: 'R:', wtask: 'W:' }[S.sideMode];
  const groups = [];
  if (S.sideMode === 'rpass' && list.some((r) => r.theme === 'story')) groups.push({ title: '📖 이야기·교훈', list: list.filter((r) => r.theme === 'story') });
  for (const lv of LEVEL_ORDER) groups.push({ title: levelName(lv), list: list.filter((x) => x.level === lv && !(S.sideMode === 'rpass' && x.theme === 'story')) });
  const cur = S.cornerId;
  $('#sideList').innerHTML = groups.filter((g) => g.list.length).map((g) => {
    const gk = S.sideMode + ':' + g.title;
    const open = store.open?.[gk] ?? (g.list.some((x) => x.id === cur) || (!cur && g === groups[0]));
    const done = g.list.filter((x) => gxDone(pre + x.id)).length;
    return `<div class="side-group"><button class="side-group-title" data-group="${esc(gk)}" style="width:100%;background:none;border:0;cursor:pointer">
      <span>${open ? '▾' : '▸'} ${esc(g.title)}</span><span>${done}/${g.list.length}</span></button>
      ${!open ? '' : g.list.map((x) => `<button class="side-item ${cur === x.id && S.view !== 'grammar' && S.view !== 'reading' && S.view !== 'writing' ? 'on' : ''}" data-${kind}="${esc(x.id)}">
        <span class="em">${x.emoji || '📘'}</span><span class="t">${esc(x.title)}</span><span class="ck">${gxDone(pre + x.id) ? '✓' : ''}</span></button>`).join('')}</div>`;
  }).join('') || '<div class="rp-hint" style="padding:10px">준비 중</div>';
}

// ================= 🖼️ 묘사 연습 =================
const DESC_CATS = [['사물', '🧸'], ['사람', '🧑'], ['장소', '🏠'], ['길 안내', '🗺️'], ['과정·방법', '🍳'], ['그림·사진', '🖼️'], ['사건·경험', '📅'], ['감각·감정', '👅']];
const xDone = (id) => gxDone('X:' + id) || !!(store.xdone || {})[id];
function viewDescribe() {
  const cats = [...DESC_CATS.map((c) => c[0]), ...new Set(D.describe.map((l) => l.category).filter((c) => !DESC_CATS.some((d) => d[0] === c)))];
  return `<div class="wrap"><h1>🖼️ 묘사 연습</h1>
    <p class="sub">사물·사람·장소를 설명하고, 길을 알려 주고, 방법·그림·경험·감정까지 영어로 묘사하는 연습이에요. 묘사 틀 → 모범 묘사 → 문장 드릴 → 직접 묘사하기 순서로 해 보세요.</p>
    ${cats.map((c) => { const list = D.describe.filter((l) => l.category === c); const em = (DESC_CATS.find((d) => d[0] === c) || [])[1] || '🖼️';
      return list.length ? `<h2>${em} ${esc(c)}</h2><div class="cards">${list.map((l) => `<button class="card" data-xles="${esc(l.id)}">
        <div class="em">${l.emoji || em}</div><div class="ct">${esc(l.title)} ${xDone(l.id) ? '✅' : ''}</div><div class="cd">${esc(l.titleEn || '')}</div>
        <div style="margin-top:6px">${lvChip(l.level)}</div></button>`).join('')}</div>` : ''; }).join('')}
    ${D.describe.length ? '' : '<div class="empty">묘사 연습을 준비하고 있어요</div>'}</div>`;
}
function viewDescribeLesson() {
  const l = D.describe.find((x) => x.id === S.cornerId); if (!l) return '<div class="empty">찾을 수 없어요</div>';
  const src = 'X:' + l.id;
  const tabs = [['frame', '📖 묘사 틀'], ['model', '📄 모범 묘사'], ['drill', `🧩 문장 드릴 (${(l.drills || []).length})`], ['try', '🎤 직접 묘사하기']];
  const tab = S.ctab || 'frame';
  let body;
  if (tab === 'frame') {
    body = `<div class="point"><h3>🧭 이렇게 묘사해요</h3><p>${esc(l.intro || '')}</p>
        ${(l.order || []).length ? `<div class="wstruct">${l.order.map((o) => `<span class="chip">${esc(o)}</span>`).join(' ')}</div>` : ''}</div>
      ${(l.toolkit || []).map((g, gi) => `<div class="point"><h3>🔑 ${esc(g.group)}</h3>${(g.items || []).map((x, xi) => `<div class="xitem">
        ${exRow({ en: x.en, ko: x.ko, note: x.note }, reg(`xt:${l.id}:${gi}:${xi}`, x))}
        ${x.ex ? `<div class="xex">${exRow({ en: x.ex, ko: x.exKo }, reg(`xe:${l.id}:${gi}:${xi}`, { en: x.ex, audio: x.exAudio }))}</div>` : ''}
        ${x.ex2 ? `<div class="xex">${exRow({ en: x.ex2, ko: x.ex2Ko }, reg(`xe2:${l.id}:${gi}:${xi}`, { en: x.ex2, audio: x.ex2Audio }))}</div>` : ''}</div>`).join('')}</div>`).join('')}
      ${l.tips ? `<div class="point culture"><h3>🗣 원어민처럼</h3><p>${esc(l.tips)}</p></div>` : ''}
      <div class="lesson-actions"><button class="btn primary" data-ctab="model">📄 모범 묘사 보러 가기</button></div>`;
  } else if (tab === 'model') {
    body = (l.allModels || l.models || []).map((m, mi) => `<div class="point"><h3>📄 ${esc(m.title)} <button class="btn" data-xmodel="${mi}">▶ 듣기</button></h3>
      ${m.subject ? `<p class="rp-hint">${esc(m.subject)}</p>` : ''}
      ${(m.sentences || []).map((s, si) => `<div class="xm" data-xm="${mi}-${si}">${exRow(s, reg(`xm:${l.id}:${mi}:${si}`, s))}</div>`).join('')}</div>`).join('');
  } else if (tab === 'drill') {
    body = gxShell(src, (l.drills || []).map((d) => ({ type: 'write', ...d })));
  } else {
    store.xdraft ||= {};
    body = (l.challenges || []).map((c, ci) => {
      const k = `${l.id}:${ci}`, rk = `XR:${k}`, open = (S.xopen || {})[k];
      return `<div class="point"><h3>🎤 도전 ${ci + 1}</h3><p>${esc(c.prompt)}</p>
        ${(c.hints || []).length ? `<div class="wstruct">${c.hints.map((h) => `<span class="chip">💡 ${esc(h)}</span>`).join(' ')}</div>` : ''}
        <textarea class="wdraft xdraft" data-xdraft="${esc(k)}" spellcheck="false" placeholder="영어로 써 보세요 (자동 저장)">${esc(store.xdraft[k] || '')}</textarea>
        <div class="lesson-actions">
          <button class="btn" data-xrec="${esc(k)}">🎙 말로 묘사하기 (녹음)</button>
          <button class="btn" data-xmy="${esc(k)}" ${recordings[rk] ? '' : 'disabled'}>▶ 내 녹음 듣기</button>
          <button class="btn ${open ? 'on' : ''}" data-xsample="${esc(k)}">${open ? '예시 답안 숨기기' : '📄 예시 답안 보기'}</button>
          ${open ? `<button class="btn" data-xsplay="${ci}">▶ 예시 답안 듣기</button>` : ''}
        </div>
        ${open ? `<div class="gmore">${(c.sample || []).map((s, si) => `<div class="xm" data-xs="${ci}-${si}">${exRow(s, reg(`xs:${l.id}:${ci}:${si}`, s))}</div>`).join('')}</div>` : ''}</div>`;
    }).join('') + `<div class="lesson-actions"><button class="btn" data-xdone="${esc(l.id)}">${xDone(l.id) ? '✅ 완료됨' : '☐ 이 과 완료 표시'}</button></div>`;
  }
  const list = D.describe, i = list.indexOf(l), prev = list[i - 1], next = list[i + 1];
  return `<div class="wrap">
    <div class="lesson-head"><div class="big">${l.emoji || '🖼️'}</div>
      <div style="flex:1"><div>${lvChip(l.level)} <span class="chip">${esc(l.category || '')}</span></div>
        <h1 style="margin-top:6px">${esc(l.title)}</h1><p class="sub" style="margin:0">${esc(l.titleEn || '')}</p></div>
      ${xDone(l.id) ? '<div class="stat" style="text-align:right"><b>✅</b><span>완료</span></div>' : ''}</div>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-ctab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}
    <div class="lesson-actions" style="margin-top:24px; justify-content:space-between">
      ${prev ? `<button class="btn" data-xles="${esc(prev.id)}">← ${esc(prev.title)}</button>` : '<span></span>'}
      ${next ? `<button class="btn" data-xles="${esc(next.id)}">${esc(next.title)} →</button>` : ''}</div></div>`;
}
function renderSideDescribe() {
  const cur = S.view === 'xles' ? S.cornerId : null;
  const cats = [...new Set(D.describe.map((l) => l.category))];
  $('#sideList').innerHTML = cats.map((c) => {
    const list = D.describe.filter((l) => l.category === c);
    const gk = 'desc:' + c, em = (DESC_CATS.find((d) => d[0] === c) || [])[1] || '🖼️';
    const open = store.open?.[gk] ?? (list.some((l) => l.id === cur) || (!cur && c === cats[0]));
    return `<div class="side-group"><button class="side-group-title" data-group="${esc(gk)}" style="width:100%;background:none;border:0;cursor:pointer">
      <span>${open ? '▾' : '▸'} ${em} ${esc(c)}</span><span>${list.filter((l) => xDone(l.id)).length}/${list.length}</span></button>
      ${!open ? '' : list.map((l) => `<button class="side-item ${cur === l.id ? 'on' : ''}" data-xles="${esc(l.id)}"><span class="em">${l.emoji || em}</span><span class="t">${esc(l.title)}</span><span class="ck">${xDone(l.id) ? '✓' : ''}</span></button>`).join('')}</div>`;
  }).join('') || '<div class="rp-hint" style="padding:10px">준비 중</div>';
}

// ================= 🀄 사자성어 → 영어로 설명하기 =================
const SJ_CATS = ['노력·성공', '학문·배움', '우정·관계', '말·행동', '지혜·처세', '감정·마음', '상황·형편', '시간·변화'];
const SJ = { tab: 'list', cat: 'all', q: '', open: new Set(), queue: [], qi: 0, reveal: false, hideKo: false, hint: false, qz: null };
const jKey = (it) => 'J:' + it.id;
const jKnown = (it) => !!(store.known || {})[jKey(it)];
const sjList = () => D.saja.filter((it) => (SJ.cat === 'all' || it.cat === SJ.cat)
  && (!SJ.q || [it.hangul, it.hanja, it.ko, it.explain, ...(it.equivalent || []).map((e) => e.en)].some((v) => String(v || '').toLowerCase().includes(SJ.q.toLowerCase()))));
function sjDetail(it) {
  return `<div class="sjd">
    ${it.literal ? `<div class="ex"><button class="play" data-sjp="${esc(it.id)}:lit">▶</button><div><span class="rp-hint">글자 그대로</span> <span class="ex-en">${esc(it.literal)}</span></div></div>` : ''}
    <div class="sj-explain"><div class="ex"><button class="play" data-sjp="${esc(it.id)}:exp">▶</button><div><div class="ex-en">${esc(it.explain)}</div><div class="ex-ko">${esc(it.explainKo || '')}</div></div></div></div>
    ${(it.equivalent || []).length ? `<div class="gmore-h" style="margin-top:8px">🇬🇧 비슷한 영어 표현</div>${it.equivalent.map((e, i) => `<div class="ex"><button class="play" data-sjp="${esc(it.id)}:eq${i}">▶</button><div><div class="ex-en">${esc(e.en)}</div><div class="ex-ko">${esc(e.ko || '')}${e.note ? ' · ' + esc(e.note) : ''}</div></div></div>`).join('')}` : ''}
    <div class="gmore-h" style="margin-top:8px">💬 이런 상황에 써요</div>
    ${(it.examples || []).map((e, i) => `<div class="ex"><button class="play" data-sjp="${esc(it.id)}:ex${i}">▶</button><div><div class="ex-en">${esc(e.en)}</div><div class="ex-ko">${esc(e.ko || '')}</div></div></div>`).join('')}
    ${(it.keywords || []).length ? `<div class="wstruct">${it.keywords.map((k) => `<span class="chip">🔑 ${esc(k)}</span>`).join(' ')}</div>` : ''}
    ${it.tip ? `<div class="note" style="margin-top:6px">💡 ${esc(it.tip)}</div>` : ''}
  </div>`;
}
function viewSaja() {
  const total = D.saja.length, known = D.saja.filter(jKnown).length;
  const tabs = [['list', '📚 목록'], ['practice', '🗣 영어로 설명하기'], ['quiz', '🧩 퀴즈']];
  const chips = `<div class="chips">${[['all', '전체'], ...SJ_CATS.filter((c) => D.saja.some((x) => x.cat === c)).map((c) => [c, c])].map(([k, n]) => `<button class="fchip ${SJ.cat === k ? 'on' : ''}" data-sjcat="${esc(k)}">${esc(n)}</button>`).join('')}</div>`;
  let body = '';
  if (SJ.tab === 'list') {
    const list = sjList();
    body = `<div class="filters"><input class="search" id="sjSearch" placeholder="사자성어·뜻·영어로 검색 (예: 일석이조, birds)" value="${esc(SJ.q)}">${chips}</div>
      <div class="count">${list.length}개</div>
      <div class="sjlist">${list.map((it) => { const open = SJ.open.has(it.id); return `<div class="sjrow ${jKnown(it) ? 'known' : ''}">
        <div class="sjhead" data-sjopen="${esc(it.id)}"><span class="sj-h">${esc(it.hangul)}</span><span class="sj-hj">${esc(it.hanja || '')}</span>
          <span class="sj-ko">${esc(it.ko)}</span><span class="chip">${esc(it.cat || '')}</span></div>
        <div class="sjtools"><button class="wknown ${jKnown(it) ? 'on' : ''}" data-wknown="${esc(jKey(it))}">${jKnown(it) ? '✔ 외움' : '외웠어요'}</button><button class="tool" data-sjopen="${esc(it.id)}">${open ? '접기 ▲' : '영어 설명 ▼'}</button></div>
        ${open ? sjDetail(it) : ''}</div>`; }).join('') || '<div class="empty">찾는 사자성어가 없어요</div>'}</div>`;
  } else if (SJ.tab === 'practice') {
    if (!SJ.queue.length) {
      const pool = sjList();
      SJ.queue = [...shuffle(pool.filter((x) => !jKnown(x))), ...shuffle(pool.filter(jKnown))].map((x) => x.id); SJ.qi = 0; SJ.reveal = false;
    }
    const it = D.saja.find((x) => x.id === SJ.queue[SJ.qi]);
    store.sjdraft ||= {};
    const draft = it ? store.sjdraft[it.id] || '' : '';
    const used = (k) => draft.toLowerCase().includes(String(k).toLowerCase());
    body = `<div class="filters">${chips}</div>` + (!it ? '<div class="empty">연습할 사자성어가 없어요</div>' : `
      <div class="fc-count">${SJ.qi + 1} / ${SJ.queue.length} · 안 외운 것부터</div>
      <div class="rp-stage sj-card"><div class="sj-big">${esc(it.hangul)}</div><div class="sj-hj" style="font-size:20px">${esc(it.hanja || '')}</div>
        ${SJ.hideKo ? '<div class="rp-hint">뜻 가림</div>' : `<div class="rp-hint" style="margin-top:6px">${esc(it.ko)}</div>`}
        <div class="lesson-actions" style="justify-content:center">
          <label class="tg"><input type="checkbox" id="sjHideKo" ${SJ.hideKo ? 'checked' : ''}><span>한국어 뜻 가리기</span></label>
          <button class="btn ${SJ.hint ? 'on' : ''}" data-sjact="hint">🔑 핵심 단어 힌트</button></div>
        ${SJ.hint ? `<div class="wstruct" style="justify-content:center">${(it.keywords || []).map((k) => `<span class="chip">${esc(k)}</span>`).join(' ')}</div>` : ''}
      </div>
      <p class="sub" style="margin:10px 0 4px">이 사자성어를 외국인 친구에게 설명한다고 생각하고 영어로 써 보거나 말해 보세요.</p>
      <textarea class="wdraft xdraft" id="sjDraft" spellcheck="false" placeholder="It means ... / You can use it when ...">${esc(draft)}</textarea>
      <div class="lesson-actions">
        <button class="btn" data-sjact="rec">🎙 말로 설명하기 (녹음)</button>
        <button class="btn" data-sjact="myrec" ${recordings['SJ:' + it.id] ? '' : 'disabled'}>▶ 내 녹음</button>
        <button class="btn primary" data-sjact="reveal">${SJ.reveal ? '모범 설명 숨기기' : '📄 모범 설명 보기'}</button>
      </div>
      ${SJ.reveal ? `<div class="point">
        ${(it.keywords || []).length ? `<div class="rp-hint">핵심 단어 사용: ${it.keywords.filter(used).length} / ${it.keywords.length}</div>
          <div class="wstruct">${it.keywords.map((k) => `<span class="chip ${used(k) ? 'kw-on' : ''}">${used(k) ? '✔' : '○'} ${esc(k)}</span>`).join(' ')}</div>` : ''}
        ${sjDetail(it)}</div>
        <div class="fc-actions"><button class="btn fc-no" data-sjact="again">↺ 다시 볼래요</button><button class="btn fc-yes" data-sjact="ok">✔ 설명할 수 있어요</button></div>` : ''}
    `);
  } else {
    body = `<div class="filters">${chips}</div><div id="sjQuiz"></div>`;
  }
  return `<div class="wrap"><h1>🀄 사자성어</h1>
    <p class="sub">사자성어를 보고 그 뜻을 영어로 설명하는 공부예요. 목록에서 영어 설명을 익히고, 직접 설명해 보고, 퀴즈로 확인하세요. 외운 것 ${known} / ${total}</p>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-sjtab="${k}" class="${SJ.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}${D.saja.length ? '' : '<div class="empty">사자성어를 준비하고 있어요</div>'}</div>`;
}
// 퀴즈: 영어 설명 → 사자성어 / 사자성어 → 비슷한 영어 표현
function sjQuizStart(mode) {
  const pool = sjList().filter((x) => mode === 'eq' ? (x.equivalent || []).length : true);
  SJ.qz = { mode, items: shuffle(pool).slice(0, 10).map((x) => x.id), i: 0, score: 0, picked: null, choices: [] };
  sjQuizMake(); sjQuizRender();
}
function sjQuizMake() {
  const q = SJ.qz, it = D.saja.find((x) => x.id === q.items[q.i]); if (!it) return;
  const others = shuffle(D.saja.filter((x) => x.id !== it.id && (q.mode !== 'eq' || (x.equivalent || []).length))).slice(0, 3);
  q.choices = shuffle([it, ...others]).map((x) => x.id); q.picked = null;
}
function sjQuizRender() {
  const box = $('#sjQuiz'); if (!box) return;
  const q = SJ.qz;
  const head = `<div class="rp-setup"><span>문제</span><div class="seg">
      <button data-sjq="explain" class="${q && q.mode === 'explain' ? 'on' : ''}">영어 설명 → 사자성어</button>
      <button data-sjq="eq" class="${q && q.mode === 'eq' ? 'on' : ''}">사자성어 → 영어 속담</button></div><span class="rp-hint">숫자키 1~4 · Enter 다음</span></div>`;
  if (!q) { box.innerHTML = head + '<div class="rp-stage"><div class="rp-hint">위에서 문제 종류를 고르면 10문제가 나와요.</div></div>'; return; }
  if (q.i >= q.items.length) { box.innerHTML = head + `<div class="rp-stage"><div class="rp-ko">${q.score} / ${q.items.length} 정답</div><button class="btn primary" data-sjq="${q.mode}">⟳ 새 문제</button></div>`; return; }
  const it = D.saja.find((x) => x.id === q.items[q.i]);
  const label = (x) => q.mode === 'eq' ? x.equivalent[0].en : `${x.hangul} ${x.hanja || ''}`;
  box.innerHTML = head + `<div class="fc-count">${q.i + 1} / ${q.items.length} · 정답 ${q.score}</div>
    <div class="rp-stage" style="text-align:center">
      ${q.mode === 'eq' ? `<div class="sj-big">${esc(it.hangul)}</div><div class="rp-hint">${esc(it.ko)}</div>` : `<div class="ex-en" style="font-size:17px">${esc(it.explain)}</div><button class="tool" data-sjp="${esc(it.id)}:exp">🔊 듣기</button>`}
      <div class="qz-choices">${q.choices.map((cid, n) => { const c = D.saja.find((x) => x.id === cid);
        const cls = q.picked == null ? '' : cid === it.id ? 'right' : cid === q.picked ? 'wrong' : 'dim';
        return `<button class="qz-opt ${cls}" data-sjpick="${esc(cid)}"><b>${n + 1}</b> ${esc(label(c))}</button>`; }).join('')}</div>
      ${q.picked != null ? `<div class="qz-after">${q.picked === it.id ? '⭕ 정답!' : '❌ 정답은 초록색'} · <b>${esc(it.hangul)}</b> — ${esc(it.explain)}
        <div style="margin-top:10px"><button class="btn primary" data-sjq="next">${q.i + 1 < q.items.length ? '다음 →' : '결과 보기'}</button></div></div>` : ''}
    </div>`;
}
function sjPlay(spec) {
  const [id, what] = spec.split(':');
  const it = D.saja.find((x) => x.id === id); if (!it) return;
  stopAll();
  if (what === 'exp') return playClip(it.audio, it.explain);
  if (what === 'lit') return playClip(it.literalAudio, it.literal);
  const arr = what.startsWith('eq') ? it.equivalent : it.examples, e = arr && arr[Number(what.slice(2))];
  if (e) playClip(e.audio, e.en);
}
function renderSideSaja() {
  $('#sideList').innerHTML = `<div class="side-group"><div class="side-group-title"><span>🀄 주제</span><span>${D.saja.filter(jKnown).length}/${D.saja.length}</span></div>
    ${[['all', '전체'], ...SJ_CATS.map((c) => [c, c])].map(([k, n]) => { const list = k === 'all' ? D.saja : D.saja.filter((x) => x.cat === k); return list.length ? `<button class="side-item ${SJ.cat === k ? 'on' : ''}" data-sjcat="${esc(k)}">
      <span class="t">${esc(n)}</span><span class="ck">${list.filter(jKnown).length}/${list.length}</span></button>` : ''; }).join('')}</div>`;
}

// ================= 💯 천 문장 구문 =================
const SS = { chunk: true, onlyUnknown: false };
const sKey = (u, i) => `S:${u.id}:${i}`;
const sentNo = (() => { let cache = null; return (u, i) => {
  if (!cache) { cache = new Map(); let n = 0; for (const x of D.sentUnits) { cache.set(x.id, n); n += (x.sentences || []).length; } }
  return (cache.get(u.id) || 0) + i + 1;
}; })();
const sKnownCount = (u) => (u.sentences || []).filter((s, i) => (store.known || {})[sKey(u, i)]).length;
function viewSents() {
  const total = D.sentUnits.reduce((s, u) => s + (u.sentences || []).length, 0);
  const known = D.sentUnits.reduce((s, u) => s + sKnownCount(u), 0);
  const parts = [...new Set(D.sentUnits.map((u) => u.part))];
  return `<div class="wrap"><h1>💯 천 문장 구문</h1>
    <p class="sub">구문(문장 구조)별로 고른 1,000문장을 끊어 읽고, 듣고, 외우는 코너예요. 모든 문장은 이 프로그램용으로 새로 쓴 문장이에요.</p>
    <div class="hero" style="margin-bottom:6px"><div class="stats">
      <div class="stat"><b>${D.sentUnits.length}</b><span>유닛</span></div>
      <div class="stat"><b>${total}</b><span>문장</span></div>
      <div class="stat"><b>${known}</b><span>외운 문장</span></div></div>
      <div style="flex:1;min-width:200px"><div class="bar" style="height:10px"><i style="width:${total ? Math.round((known / total) * 100) : 0}%"></i></div>
      <div class="rp-hint" style="margin-top:4px">전체 진도 ${total ? Math.round((known / total) * 100) : 0}%</div></div></div>
    ${parts.map((p) => `<h2>${esc(p || '')}</h2><div class="cards">${D.sentUnits.filter((u) => u.part === p).map((u) => {
      const n = (u.sentences || []).length, k = sKnownCount(u);
      return `<button class="card" data-sunit="${esc(u.id)}"><div class="cd">${esc(u.id.toUpperCase())} · ${sentNo(u, 0)}–${sentNo(u, n - 1)}</div>
        <div class="ct">${esc(u.title)} ${k === n && n ? '✅' : ''}</div><div class="cd">${esc(u.pattern || '')}</div>
        <div style="margin-top:6px">${lvChip(u.level)} <span class="rp-hint">${k}/${n}</span></div><div class="bar"><i style="width:${n ? Math.round((k / n) * 100) : 0}%"></i></div></button>`;
    }).join('')}</div>`).join('')}
    ${D.sentUnits.length ? '' : '<div class="empty">문장을 준비하고 있어요</div>'}</div>`;
}
function viewSentUnit() {
  const u = D.sentUnits.find((x) => x.id === S.cornerId); if (!u) return '<div class="empty">유닛을 찾을 수 없어요</div>';
  const n = (u.sentences || []).length, k = sKnownCount(u);
  const tabs = [['list', '📋 문장'], ['typing', '⌨️ 영작 타이핑']];
  let body;
  if (S.ctab === 'typing') body = typingShell('sunit:' + u.id);
  else {
    const idx = (u.sentences || []).map((s, i) => i).filter((i) => !SS.onlyUnknown || !(store.known || {})[sKey(u, i)]);
    body = `<div class="slist ${store.ko ? '' : 'no-ko'}">${idx.map((i) => {
      const s = u.sentences[i], key = sKey(u, i), known = !!(store.known || {})[key];
      return `<div class="srow ${known ? 'known' : ''}" data-srow="${i}">
        <div class="sno">${String(sentNo(u, i)).padStart(3, '0')}</div>
        <button class="play" data-splay="${i}">▶</button>
        <div class="smain">
          <div class="sen" data-splay="${i}">${SS.chunk && s.chunk ? esc(s.chunk).replace(/ \/ /g, ' <span class="slash">/</span> ') : esc(s.en)}</div>
          <div class="wko">${esc(s.ko)}</div>
          ${s.point ? `<div class="note">💡 ${esc(s.point)}</div>` : ''}
        </div>
        <button class="wknown ${known ? 'on' : ''}" data-wknown="${esc(key)}">${known ? '✔ 외움' : '외웠어요'}</button>
        ${starBtn(key)}
      </div>`;
    }).join('') || '<div class="empty">🎉 이 유닛은 다 외웠어요!</div>'}</div>`;
  }
  return `<div class="wrap">
    <div class="lesson-head"><div class="big">💯</div>
      <div style="flex:1"><div>${lvChip(u.level)} <span class="chip">${esc(u.part || '')}</span></div>
        <h1 style="margin-top:6px">${esc(u.id.toUpperCase())} · ${esc(u.title)}</h1><p class="sub" style="margin:0">${esc(u.pattern || '')} · ${sentNo(u, 0)}–${sentNo(u, n - 1)}번 문장</p></div>
      <div class="stat" style="text-align:right"><b>${k}/${n}</b><span>외운 문장</span></div></div>
    ${u.summary ? `<div class="point" style="margin-top:12px"><h3>📌 구문 설명</h3><p>${esc(u.summary)}</p></div>` : ''}
    <div class="lesson-actions">
      <button class="btn primary" data-sact="playall">▶ 전체 듣기</button>
      <button class="btn" data-sact="shadow">🗣 따라 말하기</button>
      <button class="btn" data-act="stop">■ 멈춤</button>
      <label class="tg"><input type="checkbox" id="sChunk" ${SS.chunk ? 'checked' : ''}><span>끊어 읽기 표시</span></label>
      <label class="tg"><input type="checkbox" id="sOnly" ${SS.onlyUnknown ? 'checked' : ''}><span>안 외운 문장만</span></label>
    </div>
    <div class="tabs">${tabs.map(([t, nm]) => `<button data-ctab="${t}" class="${(S.ctab || 'list') === t ? 'on' : ''}">${nm}</button>`).join('')}</div>
    ${body}
    <div class="lesson-actions" style="margin-top:24px; justify-content:space-between">
      ${(() => { const i = D.sentUnits.indexOf(u), p = D.sentUnits[i - 1], nx = D.sentUnits[i + 1];
        return `${p ? `<button class="btn" data-sunit="${esc(p.id)}">← ${esc(p.title)}</button>` : '<span></span>'}${nx ? `<button class="btn" data-sunit="${esc(nx.id)}">${esc(nx.title)} →</button>` : ''}`; })()}
    </div></div>`;
}
function sentItems(u, mode) {
  return (u.sentences || []).map((s, i) => ({ en: s.en, ko: s.ko, audio: s.audio, key: sKey(u, i),
    exp: [s.chunk && `끊어 읽기: ${s.chunk}`, s.point && `💡 ${s.point}`].filter(Boolean).join('\n') }))
    .filter((x) => mode !== 'unknown' || !(store.known || {})[x.key]);
}
function renderSideSents() {
  const cur = S.view === 'sunit' ? S.cornerId : null;
  const parts = [...new Set(D.sentUnits.map((u) => u.part))];
  $('#sideList').innerHTML = parts.map((p) => {
    const list = D.sentUnits.filter((u) => u.part === p);
    const gk = 'sents:' + p;
    const open = store.open?.[gk] ?? (list.some((u) => u.id === cur) || (!cur && p === parts[0]));
    const k = list.reduce((s, u) => s + sKnownCount(u), 0), n = list.reduce((s, u) => s + (u.sentences || []).length, 0);
    return `<div class="side-group"><button class="side-group-title" data-group="${esc(gk)}" style="width:100%;background:none;border:0;cursor:pointer">
      <span>${open ? '▾' : '▸'} ${esc(p || '')}</span><span>${k}/${n}</span></button>
      ${!open ? '' : list.map((u) => { const nn = (u.sentences || []).length, kk = sKnownCount(u); return `<button class="side-item ${cur === u.id ? 'on' : ''}" data-sunit="${esc(u.id)}">
        <span class="em" style="font-size:11px">${esc(u.id.slice(1))}</span><span class="t">${esc(u.title)}</span><span class="ck">${kk === nn && nn ? '✓' : kk ? kk : ''}</span></button>`; }).join('')}</div>`;
  }).join('') || '<div class="rp-hint" style="padding:10px">준비 중</div>';
}

// ================= 렌더 =================
function render() {
  const main = $('#main');
  const keepScroll = S._keepScroll ? main.scrollTop : 0;
  if (S.view === 'home') main.innerHTML = viewHome();
  else if (S.view === 'levels') main.innerHTML = viewLevels();
  else if (S.view === 'themes') main.innerHTML = viewThemes();
  else if (S.view === 'idioms') main.innerHTML = viewIdioms();
  else if (S.view === 'review') main.innerHTML = viewReview();
  else if (S.view === 'words') main.innerHTML = viewWords();
  else if (S.view === 'deck') main.innerHTML = viewDeck();
  else if (S.view === 'saja') main.innerHTML = viewSaja();
  else if (S.view === 'describe') main.innerHTML = viewDescribe();
  else if (S.view === 'xles') main.innerHTML = viewDescribeLesson();
  else if (S.view === 'sents') main.innerHTML = viewSents();
  else if (S.view === 'sunit') main.innerHTML = viewSentUnit();
  else if (S.view === 'grammar') main.innerHTML = viewGrammar();
  else if (S.view === 'gunit') main.innerHTML = viewGrammarUnit();
  else if (S.view === 'reading') main.innerHTML = viewReading();
  else if (S.view === 'rpass') main.innerHTML = viewReadingPassage();
  else if (S.view === 'writing') main.innerHTML = viewWriting();
  else if (S.view === 'wtask') main.innerHTML = viewWritingTask();
  else main.innerHTML = viewLesson();
  main.scrollTop = keepScroll;
  S._keepScroll = false;
  if ($('#tyBox')) tyRender();
  if ($('#fcBox')) fcRender(false);
  if ($('#qzBox')) qzRender();
  if ($('#gxBox')) gxRender();
  if ($('#sjQuiz')) sjQuizRender();
  document.querySelectorAll('#nav button').forEach((b) => {
    const v = b.dataset.view;
    b.classList.toggle('on', v === S.view || (S.view === 'deck' && v === 'words') || ({ gunit: 'grammar', rpass: 'reading', wtask: 'writing', sunit: 'sents', xles: 'describe' }[S.view] === v) || (S.view === 'lesson' && ((v === 'levels' && S.sideMode === 'level') || (v === 'themes' && S.sideMode === 'theme'))));
  });
  renderSide();
}
function rerender() { S._keepScroll = true; render(); }

function openLesson(id) {
  stopAll();
  RP.running = false;
  S.view = 'lesson'; S.lessonId = id; S.tab = 'chat';
  store.last = id; save();
  render();
  $('#main').scrollTop = 0;
}

async function playSequence(items, { shadow = false } = {}) {
  stopAll();
  const token = ++playToken;
  for (const it of items) {
    if (token !== playToken) return;
    markRow(it.row ? it.row() : null);
    await playClip(it.audio, it.say || it.en);
    if (token !== playToken) return;
    if (shadow) {
      const d = await clipDuration(it.audio, it.say || it.en);
      setNow('🗣 따라 말해 보세요…');
      await sleep(Math.round((d / store.rate) * 1300 + 700));
    } else await sleep(350);
  }
  if (token === playToken) { markRow(null); setNow(''); }
}

// ================= 이벤트 =================
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, input[data-fc], [data-play-line], [data-play-phrase], [data-rvplay], [data-wtoggle], [data-fc], [data-rs], [data-sjopen], .idiom-mark');
  if (!t) { hidePop(); return; }
  const ds = t.dataset;
  const l = S.lessonId && lessonById(S.lessonId);

  if (t.classList.contains('idiom-mark')) { e.stopPropagation(); showPop(t); return; }
  hidePop();

  if (ds.view) {
    stopAll();
    S.view = ds.view;
    if (ds.view === 'levels') S.sideMode = 'level';
    if (ds.view === 'themes') S.sideMode = 'theme';
    if (ds.view === 'words') S.sideMode = 'words';
    if (ds.view === 'sents') { S.sideMode = 'sents'; S.cornerId = null; }
    if (ds.view === 'describe') { S.sideMode = 'desc'; S.cornerId = null; }
    if (ds.view === 'saja') S.sideMode = 'saja';
    if (ds.view === 'grammar') { S.sideMode = 'gunit'; S.cornerId = null; }
    if (ds.view === 'reading') { S.sideMode = 'rpass'; S.cornerId = null; }
    if (ds.view === 'writing') { S.sideMode = 'wtask'; S.cornerId = null; }
    render(); $('#main').scrollTop = 0; return;
  }
  // ---- 문법·독해·작문 ----
  // ---- 사자성어 ----
  if (ds.sjtab) { stopAll(); SJ.tab = ds.sjtab; rerender(); return; }
  if (ds.sjcat) { SJ.cat = ds.sjcat; SJ.queue = []; SJ.qz = null; if (S.view !== 'saja') { S.view = 'saja'; render(); } else rerender(); return; }
  if (ds.sjopen) { if (SJ.open.has(ds.sjopen)) SJ.open.delete(ds.sjopen); else SJ.open.add(ds.sjopen); rerender(); return; }
  if (ds.sjp) { sjPlay(ds.sjp); return; }
  if (ds.sjq) { if (ds.sjq === 'next') { if (SJ.qz && SJ.qz.picked != null) { SJ.qz.i++; sjQuizMake(); sjQuizRender(); } } else sjQuizStart(ds.sjq); return; }
  if (ds.sjpick) {
    const q = SJ.qz; if (!q || q.picked != null) return;
    q.picked = ds.sjpick; const it = D.saja.find((x) => x.id === q.items[q.i]);
    if (q.picked === it.id) q.score++;
    sjQuizRender(); stopAll(); if (q.mode === 'eq') playClip(it.equivalent[0].audio, it.equivalent[0].en); else playClip(it.audio, it.explain);
    return;
  }
  if (ds.sjact) {
    const it = D.saja.find((x) => x.id === SJ.queue[SJ.qi]); if (!it) return;
    if (ds.sjact === 'hint') { SJ.hint = !SJ.hint; rerender(); return; }
    if (ds.sjact === 'reveal') { SJ.reveal = !SJ.reveal; rerender(); if (SJ.reveal) { stopAll(); playClip(it.audio, it.explain); } return; }
    if (ds.sjact === 'myrec') { const u = recordings['SJ:' + it.id]; if (u) { stopAll(); playUrl(u); } return; }
    if (ds.sjact === 'ok' || ds.sjact === 'again') {
      if (ds.sjact === 'ok') setKnown(jKey(it), true); else SJ.queue.push(it.id);
      SJ.qi = (SJ.qi + 1) % SJ.queue.length; SJ.reveal = false; SJ.hint = false; stopAll(); rerender(); renderSide(); return;
    }
    if (ds.sjact === 'rec') {
      const key = 'SJ:' + it.id;
      if (rec) { stopRecording(); return; }
      stopAll(); playToken++;
      try { t.textContent = '⏺ 녹음 중… (누르면 멈춤)'; setNow('🎙 녹음 중…'); const auto = setTimeout(stopRecording, 60000); await startRecording(key); clearTimeout(auto); setNow(''); rerender(); await playUrl(recordings[key]); }
      catch { t.textContent = '⚠️ 마이크 없음'; }
      return;
    }
  }
  if (ds.xles) { openCorner('xles', ds.xles); return; }
  if (ds.xmodel != null) {
    const l = D.describe.find((x) => x.id === S.cornerId), m = l && (l.allModels || l.models)[Number(ds.xmodel)];
    if (m) playSequence(m.sentences.map((s, si) => ({ ...s, row: () => document.querySelector(`.xm[data-xm="${ds.xmodel}-${si}"]`) })));
    return;
  }
  if (ds.xsplay != null) {
    const l = D.describe.find((x) => x.id === S.cornerId), c = l && l.challenges[Number(ds.xsplay)];
    if (c) playSequence(c.sample.map((s, si) => ({ ...s, row: () => document.querySelector(`.xm[data-xs="${ds.xsplay}-${si}"]`) })));
    return;
  }
  if (ds.xsample) { S.xopen ||= {}; S.xopen[ds.xsample] = !S.xopen[ds.xsample]; rerender(); return; }
  if (ds.xdone) { store.xdone ||= {}; if (store.xdone[ds.xdone]) delete store.xdone[ds.xdone]; else store.xdone[ds.xdone] = Date.now(); save(); rerender(); return; }
  if (ds.xmy) { const u = recordings['XR:' + ds.xmy]; if (u) { stopAll(); playUrl(u); } return; }
  if (ds.xrec) {
    const key = 'XR:' + ds.xrec;
    if (rec) { stopRecording(); return; }
    stopAll(); playToken++;
    try {
      t.textContent = '⏺ 녹음 중… (누르면 멈춤)'; t.classList.add('on'); setNow('🎙 녹음 중… 최대 90초');
      const auto = setTimeout(stopRecording, 90000);
      await startRecording(key);
      clearTimeout(auto); setNow('');
      rerender();
      await playUrl(recordings[key]);
    } catch { t.textContent = '⚠️ 마이크 없음'; }
    return;
  }
  if (ds.sunit) { openCorner('sunit', ds.sunit); return; }
  if (ds.splay != null) {
    const un = D.sentUnits.find((x) => x.id === S.cornerId), s = un && un.sentences[Number(ds.splay)];
    if (s) { stopAll(); playToken++; markRow(document.querySelector(`.srow[data-srow="${ds.splay}"]`)); playClip(s.audio, s.en).then(() => markRow(null)); }
    return;
  }
  if (ds.sact) {
    const un = D.sentUnits.find((x) => x.id === S.cornerId); if (!un) return;
    const idx = un.sentences.map((s, i) => i).filter((i) => !SS.onlyUnknown || !(store.known || {})[sKey(un, i)]);
    playSequence(idx.map((i) => ({ ...un.sentences[i], row: () => document.querySelector(`.srow[data-srow="${i}"]`) })), { shadow: ds.sact === 'shadow' });
    return;
  }
  if (ds.gdlg) { const un = D.grammar.find((x) => x.id === ds.gdlg); if (un) playSequence(un.dialogue.map((x, xi) => ({ ...x, row: () => document.querySelector(`.gdl[data-gdl="${xi}"]`) }))); return; }
  if (ds.gunit) { openCorner('gunit', ds.gunit); return; }
  if (ds.rpass) { openCorner('rpass', ds.rpass); return; }
  if (ds.wtask) { openCorner('wtask', ds.wtask); return; }
  if (ds.ctab) { stopAll(); S.ctab = ds.ctab; rerender(); return; }
  if (ds.gx) { gxAction(ds.gx); return; }
  if (ds.cplay) { const it = CPLAY.get(ds.cplay); if (it) { stopAll(); playClip(it.audio, it.say || it.en); } return; }
  if (ds.rs) {
    const it = CPLAY.get(ds.rs);
    if (!RS.allKo) { if (RS.open.has(ds.rs)) RS.open.delete(ds.rs); else RS.open.add(ds.rs); rerender(); }
    if (it) { stopAll(); markRow(document.querySelector(`[data-rs="${CSS.escape(ds.rs)}"]`)); playClip(it.audio, it.en).then(() => markRow(null)); }
    return;
  }
  if (ds.ract === 'allko') { RS.allKo = !RS.allKo; rerender(); return; }
  if (ds.ract === 'playall') { audiobook([S.cornerId], { repeat: RS.repeat }); return; }
  if (ds.ract === 'repeat') { RS.repeat = !RS.repeat; rerender(); return; }
  if (ds.rbook) { audiobook(ds.rbook.split(',')); return; }
  if (ds.wtact) {
    const w = D.writing.find((x) => x.id === S.cornerId);
    if (ds.wtact === 'playmodel') { playSequence((w.model || []).map((x) => ({ ...x }))); return; }
    if (ds.wtact === 'compare') { S.wCompare = true; rerender(); document.querySelector('.wcompare')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (ds.wtact === 'done') { store.wdone ||= {}; store.wdone[w.id] = !store.wdone[w.id]; if (!store.wdone[w.id]) delete store.wdone[w.id]; save(); rerender(); return; }
  }
  // ---- 단어장 ----
  if (ds.deck) { openDeck(ds.deck); return; }
  if (ds.dtab) { stopAll(); S.dtab = ds.dtab; rerender(); return; }
  if (ds.fc) { if (ds.fc !== 'shuffle') fcAction(ds.fc, t); return; }
  if (ds.qz) { qzAction(ds.qz); return; }
  if (ds.wplay) { const r = wordByKey(ds.wplay); if (r) { stopAll(); playClip(r.w.audio, r.w.say || r.w.en); } return; }
  if (ds.wex) { const r = wordByKey(ds.wex); if (r && r.w.ex) { stopAll(); playClip(r.w.exAudio, r.w.ex); } return; }
  if (ds.wknown) {
    const on = !(store.known || {})[ds.wknown];
    setKnown(ds.wknown, on);
    if (S.view === 'deck' && WS.onlyUnknown && S.dtab === 'list') rerender();
    else { t.classList.toggle('on', on); t.textContent = on ? '✔ 외움' : '외웠어요'; t.closest('.wrow')?.classList.toggle('known', on); renderSide(); }
    return;
  }
  if (ds.wtoggle) { const m = document.querySelector(`[data-wmore="${CSS.escape(ds.wtoggle)}"]`); if (m) m.hidden = !m.hidden; return; }
  if (ds.wact === 'playall') {
    const d = deckById(S.deckId);
    playSequence(deckIdx(d).map((i) => ({ ...d.words[i] })));
    return;
  }
  if (ds.wact === 'resetknown') {
    const d = deckById(S.deckId);
    if (confirm(`'${d.name}'의 외움 표시를 모두 지울까요?`)) { d.words.forEach((w) => setKnown(wKey(d, w), false)); FC.deckId = null; rerender(); }
    return;
  }
  if (ds.tymode) { TY.mode = ds.tymode; TY.phase = 'setup'; tyRender(); return; }
  if (ds.tyhint) { TY.hint = ds.tyhint; TY.played = -1; tyRender(); return; }
  if (ds.tyact) { tyAction(ds.tyact, t); return; }
  if (ds.typlay) { const it = TY.items.find((x) => x.key === ds.typlay); if (it) { stopAll(); playClip(it.audio, it.say || it.en); } return; }
  if (ds.jump) { document.getElementById(ds.jump)?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (ds.group) { store.open ||= {}; const cur = !!t.nextElementSibling; store.open[ds.group] = !cur; save(); renderSide(); return; }
  if (ds.open) { openLesson(ds.open); return; }
  if (ds.level) { S.view = 'levels'; S.sideMode = 'level'; render(); document.getElementById('sec-' + ds.level)?.scrollIntoView(); return; }
  if (ds.themeGo) {
    const [k, id] = ds.themeGo.split(':');
    S.view = 'themes'; S.sideMode = 'theme'; render();
    document.getElementById(`sec-${k}-${id}`)?.scrollIntoView(); return;
  }
  if (ds.tab) { stopAll(); RP.running = false; S.tab = ds.tab; rerender(); return; }
  if (ds.star) {
    if (store.stars[ds.star]) delete store.stars[ds.star]; else store.stars[ds.star] = Date.now();
    save();
    t.classList.toggle('on', !!store.stars[ds.star]); t.textContent = store.stars[ds.star] ? '★' : '☆';
    if (S.view === 'review') rerender(); else renderSide();
    return;
  }
  if (ds.speed !== undefined) return;

  if (ds.playLine !== undefined && l) {
    const i = Number(ds.playLine), x = l.dialogue[i];
    stopAll(); playToken++;
    markRow(document.querySelector(`.row[data-line="${i}"]`));
    await playClip(x.audio, x.say || x.en); markRow(null); return;
  }
  if (ds.playPhrase !== undefined && l) { const p = l.phrases[Number(ds.playPhrase)]; stopAll(); await playClip(p.audio, p.say || p.en); return; }
  if (ds.repeat !== undefined && l) {
    const i = Number(ds.repeat), x = l.dialogue[i];
    const row = () => document.querySelector(`.row[data-line="${i}"]`);
    playSequence([x, x, x].map((y) => ({ ...y, row })), { shadow: false });
    return;
  }
  if (ds.exp !== undefined) {
    const box = document.querySelector(`[data-exp-box="${ds.exp}"]`);
    if (box) { box.hidden = !box.hidden; t.classList.toggle('on', !box.hidden); }
    return;
  }
  if (ds.rec !== undefined && l) {
    const i = Number(ds.rec), key = `L:${l.id}:d${i}`;
    if (rec) { stopRecording(); return; }
    stopAll(); playToken++;
    try {
      t.textContent = '⏺ 녹음 중… (누르면 멈춤)'; t.classList.add('rec'); setNow('🎙 녹음 중…');
      const auto = setTimeout(stopRecording, 12000);
      await startRecording(key);
      clearTimeout(auto);
      setNow('');
      rerender();
      await playUrl(recordings[key]);
    } catch {
      t.textContent = '⚠️ 마이크 없음';
    }
    return;
  }
  if (ds.myrec !== undefined && l) { const u = recordings[`L:${l.id}:d${ds.myrec}`]; if (u) { stopAll(); playUrl(u); } return; }
  if (ds.rpmy !== undefined && l) { const u = recordings[`RP:${l.id}:${ds.rpmy}`]; if (u) { stopAll(); playUrl(u); } return; }
  if (ds.rprole) { RP.role = ds.rprole; RP.running = false; stopAll(); rerender(); return; }
  if (ds.idplay) {
    const [id, which] = ds.idplay.split(':');
    const it = D.idioms.find((x) => x.id === id); if (!it) return;
    stopAll();
    if (which === 'h') playClip(it.audio, it.say || it.en);
    else if (which === '1') playClip(it.exAudio, it.ex);
    else playClip(it.ex2Audio, it.ex2);
    return;
  }
  if (ds.rvplay) { const it = reviewItem(ds.rvplay); if (it) { stopAll(); playClip(it.audio, it.say || it.en); } return; }
  if (ds.idlv) { S.idLevel = ds.idlv; rerender(); return; }
  if (ds.idcat) { S.idCat = ds.idcat; rerender(); return; }

  switch (ds.act) {
    case 'playall':
      if (S.tab !== 'chat') { S.tab = 'chat'; rerender(); }
      playSequence(l.dialogue.map((x, i) => ({ ...x, row: () => document.querySelector(`.row[data-line="${i}"]`) })));
      break;
    case 'shadow':
      if (S.tab !== 'chat') { S.tab = 'chat'; rerender(); }
      playSequence(l.dialogue.map((x, i) => ({ ...x, row: () => document.querySelector(`.row[data-line="${i}"]`) })), { shadow: true });
      break;
    case 'stop': stopAll(); if (RP.running) { RP.running = false; rerender(); } break;
    case 'done':
      if (store.done[l.id]) delete store.done[l.id]; else store.done[l.id] = Date.now();
      save(); rerender(); break;
    case 'rpstart': runRoleplay(l); break;
    case 'reviewtype': S.reviewTyping = !S.reviewTyping; rerender(); break;
    case 'reviewall': {
      const items = Object.keys(store.stars).map(reviewItem).filter(Boolean);
      playSequence(items, { shadow: true });
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'idSearch') {
    S.idq = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const inp = $('#idSearch'); inp.focus(); inp.setSelectionRange(pos, pos);
  }
  if (e.target.id === 'sjDraft') { store.sjdraft ||= {}; store.sjdraft[SJ.queue[SJ.qi]] = e.target.value; save(); }
  if (e.target.id === 'sjSearch') { SJ.q = e.target.value; const pos = e.target.selectionStart; rerender(); const inp = $('#sjSearch'); inp.focus(); inp.setSelectionRange(pos, pos); }
  if (e.target.dataset.xdraft) { store.xdraft ||= {}; store.xdraft[e.target.dataset.xdraft] = e.target.value; save(); }
  if (e.target.id === 'wDraft') {
    store.wdraft ||= {}; store.wdraft[S.cornerId] = e.target.value; save();
    const t = e.target.value.trim(), words = t ? t.split(/\s+/).length : 0, sents = (t.match(/[.!?](\s|$)/g) || []).length;
    const c = $('#wCount'); if (c) c.textContent = `단어 · ${sents}문장`;
    const w = D.writing.find((x) => x.id === S.cornerId);
    document.querySelectorAll('.wlist .wrow').forEach((row, i) => { const x = (w.expressions || [])[i]; if (x) row.classList.toggle('used', exprUsed(t, x.en)); });
  }
  if (e.target.id === 'wSearch') {
    WS.q = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const inp = $('#wSearch'); inp.focus(); inp.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'sjHideKo') { SJ.hideKo = e.target.checked; rerender(); }
  if (e.target.id === 'sChunk') { SS.chunk = e.target.checked; rerender(); }
  if (e.target.id === 'sOnly') { SS.onlyUnknown = e.target.checked; if (TY.src?.startsWith('sunit:')) TY.phase = 'setup'; rerender(); }
  if (e.target.id === 'readKo') { store.readKo = e.target.checked; save(); }
  if (e.target.dataset.wcheck != null) { store.wcheck ||= {}; const arr = store.wcheck[S.cornerId] ||= []; arr[Number(e.target.dataset.wcheck)] = e.target.checked; save(); }
  if (e.target.id === 'wOnly') { WS.onlyUnknown = e.target.checked; FC.deckId = null; QZ.deckId = null; if (TY.src?.startsWith('deck:')) TY.phase = 'setup'; rerender(); }
  if (e.target.dataset.fc === 'shuffle') fcAction('shuffle', e.target);
});

// 숙어 팝업
function showPop(el) {
  const it = D.idioms.find((x) => x.id === el.dataset.idiom);
  if (!it) return;
  const pop = $('#pop');
  pop.innerHTML = `<div class="idiom-top"><button class="play" data-idplay="${esc(it.id)}:h" style="width:28px;height:28px;font-size:11px">▶</button>
    <span class="idiom-en">${esc(it.en)}</span>${lvChip(it.level)}</div>
    <div class="idiom-ko">${esc(it.ko)}</div>${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}
    ${it.ex ? `<div class="ex" style="margin-top:8px"><div><div class="ex-en">${esc(it.ex)}</div><div class="ex-ko">${esc(it.exKo)}</div></div></div>` : ''}`;
  pop.hidden = false;
  const r = el.getBoundingClientRect();
  const w = 340;
  pop.style.left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left)) + 'px';
  const top = r.bottom + 8;
  pop.style.top = (top + pop.offsetHeight > window.innerHeight - 10 ? r.top - pop.offsetHeight - 8 : top) + 'px';
}
function hidePop() { $('#pop').hidden = true; }
$('#pop').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-idplay]');
  if (b) { const it = D.idioms.find((x) => x.id === b.dataset.idplay.split(':')[0]); if (it) playClip(it.audio, it.say || it.en); }
});

// 하단 바
function initBar() {
  document.querySelectorAll('#speedSeg button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.rate) === store.rate);
    b.onclick = () => {
      store.rate = Number(b.dataset.rate); save();
      player.playbackRate = store.rate;
      document.querySelectorAll('#speedSeg button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  const bind = (id, key) => {
    const el = $(id); el.checked = !!store[key];
    el.onchange = () => { store[key] = el.checked; save(); if (['lesson', 'review', 'deck', 'words'].includes(S.view)) rerender(); };
  };
  bind('#optKo', 'ko'); bind('#optHideEn', 'hideEn'); bind('#optExp', 'exp');
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { stopAll(); hidePop(); return; }
  // 플래시카드: Space 뒤집기 · ←/1 몰라요 · →/2 알아요 · ↑ 듣기
  if (S.view === 'deck' && S.dtab === 'cards' && $('#fcBox')) {
    const map = { ' ': 'flip', ArrowLeft: 'no', '1': 'no', ArrowRight: 'yes', '2': 'yes', ArrowUp: 'play' };
    if (map[e.key]) { e.preventDefault(); fcAction(map[e.key]); }
  }
  // 문법·독해 연습문제: 숫자키 선택 · Enter 확인/다음
  if ($('#gxBox') && GX.phase !== 'setup' && GX.phase !== 'done') {
    const it = GX.items[GX.idx];
    if (it && it.type === 'choice' && GX.phase === 'q' && /^[1-9]$/.test(e.key) && it.options[Number(e.key) - 1] != null) { e.preventDefault(); gxAction('pick-' + (Number(e.key) - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); GX.phase === 'q' ? gxAction('check') : gxNext(); }
  }
  // 사자성어 퀴즈: 1~4 · Enter
  if (S.view === 'saja' && SJ.tab === 'quiz' && SJ.qz && $('#sjQuiz')) {
    const q = SJ.qz;
    if (/^[1-4]$/.test(e.key) && q.picked == null && q.choices[Number(e.key) - 1]) { e.preventDefault(); document.querySelector(`[data-sjpick="${CSS.escape(q.choices[Number(e.key) - 1])}"]`)?.click(); }
    else if (e.key === 'Enter' && q.picked != null) { e.preventDefault(); q.i++; sjQuizMake(); sjQuizRender(); }
  }
  // 퀴즈: 1~4 선택 · Enter 다음
  if (S.view === 'deck' && S.dtab === 'quiz' && $('#qzBox')) {
    if (/^[1-4]$/.test(e.key) && QZ.picked == null && QZ.choices[Number(e.key) - 1] != null) { e.preventDefault(); qzAction('pick-' + QZ.choices[Number(e.key) - 1]); }
    else if (e.key === 'Enter') { e.preventDefault(); qzAction('next'); }
  }
});

// 휴대폰: ☰ 서랍 메뉴. 메뉴 안에서 항목을 고르면 닫힌다
document.getElementById('menuBtn')?.addEventListener('click', (e) => { e.stopPropagation(); document.body.classList.toggle('drawer'); });
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('drawer')) return;
  if (!e.target.closest('.side')) { document.body.classList.remove('drawer'); e.stopPropagation(); e.preventDefault(); return; }
  const b = e.target.closest('.side button');
  if (b && !b.classList.contains('side-group-title')) setTimeout(() => document.body.classList.remove('drawer'), 0);
}, true);
// 웹 버전: 홈 화면에 추가해 앱처럼 쓰도록 서비스 워커 등록 (https 또는 localhost에서만)
if (!window.api && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async function boot() {
  D = window.api ? await window.api.loadData() : await (await fetch('data.json')).json();
  buildIdiomIndex();
  initBar();
  render();
})();

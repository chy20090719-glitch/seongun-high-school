// 성운고등학교 사이트 서버 — 외부 패키지 없이 Node.js 기본 기능만 사용해요.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STAFF_CODE = process.env.STAFF_CODE || '';          // 설정하면 교직원 가입 때 인증코드가 필요해요
const SEED = process.env.SEED !== '0';                    // 0으로 두면 예시 글 없이 시작해요
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_POSTS = 500;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 저장소 (JSON 파일) ---------- */
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch (e) {
  const M = 60000, H = 60 * M, D = 24 * H, now = Date.now();
  db = { users: [], sessions: {}, posts: { student: [], staff: [] } };
  if (SEED) {
    db.posts.student = [
      { id: 'seed1', to: '1학년 2반 친구들', text: '다음 주 체육대회 같이 힘내자! 다들 응원하고 있어 💜', mode: 'anon', name: '', uid: 'seed', ts: now - 2 * H,
        replies: [{ id: 'r1', text: '고마워! 우리 반 파이팅 🔥', mode: 'anon', name: '', uid: 'seed', ts: now - H }] },
      { id: 'seed2', to: '급식실 이모님', text: '어제 돈가스 진짜 맛있었어요. 항상 감사합니다!', mode: 'named', name: '2215이서준', uid: 'seed', ts: now - 9 * H, replies: [] },
      { id: 'seed3', to: '3학년 선배님들', text: '입시 준비 힘드시겠지만 끝까지 응원할게요. 조금만 더 힘내세요!', mode: 'anon', name: '', uid: 'seed', ts: now - 2 * D, replies: [] }
    ];
    db.posts.staff = [
      { id: 'seed4', to: '선생님들께', text: '2학기 중간고사 감독 일정 확정본은 교무실 게시판에서 확인해 주세요.', mode: 'named', name: '교직원김교무', uid: 'seed', ts: now - 5 * H, replies: [] },
      { id: 'seed5', to: '모두에게', text: '사복데이 복장 지도 기준을 한 번 더 공유하면 좋겠습니다.', mode: 'anon', name: '', uid: 'seed', ts: now - D, replies: [] }
    ];
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 200);
}
save();

/* ---------- 유틸 ---------- */
const uid = () => crypto.randomBytes(6).toString('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const validId = id => id === '교직원' || /^\d{4}$/.test(id);
const validName = n => /^[가-힣a-zA-Z]{2,10}$/.test(n);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

const hits = new Map();   // 간단한 요청 제한 (IP별)
function limited(ip, key, max, windowMs) {
  const k = key + ':' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 120000)) hits.delete(k); }, 60000).unref();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (res, code, msg) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function authUser(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[m[1]];
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_MS) { delete db.sessions[m[1]]; save(); return null; }
  return db.users.find(u => u.nick === s.nick) || null;
}
function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { nick: user.nick, ts: Date.now() };
  return token;
}
const pubUser = u => ({ nick: u.nick, staff: !!u.staff });

// 익명 글은 글쓴이 정보를 서버 밖으로 내보내지 않아요.
function pubPost(p, me) {
  const mine = x => !!me && x.uid === me.nick;
  return {
    id: p.id, to: p.to, text: p.text, mode: p.mode, name: p.mode === 'named' ? p.name : '', mine: mine(p), ts: p.ts,
    replies: p.replies.map(r => ({ id: r.id, text: r.text, mode: r.mode, name: r.mode === 'named' ? r.name : '', mine: mine(r), ts: r.ts }))
  };
}
function boardOf(name, user, res) {
  if (name !== 'student' && name !== 'staff') { fail(res, 400, '게시판 이름이 올바르지 않아요.'); return null; }
  if (name === 'staff' && !(user && user.staff)) { fail(res, user ? 403 : 401, '교직원 전용 게시판이에요.'); return null; }
  return db.posts[name];
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const method = req.method, p = url.pathname;
  const user = authUser(req);

  if (method === 'GET' && p === '/api/config') return send(res, 200, { staffCodeRequired: !!STAFF_CODE });

  if (method === 'POST' && p === '/api/signup') {
    if (limited(ip, 'auth', 10, 60000)) return fail(res, 429, '시도가 너무 많아요. 잠시 뒤 다시 해 주세요.');
    const b = await readBody(req), id = clip(b.id, 10), name = clip(b.name, 10), pw = String(b.pw || '');
    if (!validId(id)) return fail(res, 400, '학번은 숫자 4자리(예: 1109)로 적어 주세요. 교직원은 “교직원”이라고 적어요.');
    if (!validName(name)) return fail(res, 400, '이름은 한글 또는 영문 2~10자로 적어 주세요.');
    if (pw.length < 4 || pw.length > 100) return fail(res, 400, '비밀번호는 4자 이상이어야 해요.');
    if (id === '교직원' && STAFF_CODE && String(b.code || '') !== STAFF_CODE) return fail(res, 403, '교직원 인증코드가 맞지 않아요.');
    const nick = id + name;
    if (db.users.some(u => u.nick === nick)) return fail(res, 409, '이미 가입된 학번·이름이에요. 로그인해 주세요.');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { nick, id, name, staff: id === '교직원', salt, hash: await scrypt(pw, salt), created: Date.now() };
    db.users.push(u);
    const token = newSession(u); save();
    return send(res, 200, { token, user: pubUser(u) });
  }

  if (method === 'POST' && p === '/api/login') {
    if (limited(ip, 'auth', 10, 60000)) return fail(res, 429, '시도가 너무 많아요. 잠시 뒤 다시 해 주세요.');
    const b = await readBody(req), u = db.users.find(x => x.nick === clip(b.id, 10) + clip(b.name, 10));
    if (!u) return fail(res, 401, '학번·이름 또는 비밀번호가 맞지 않아요.');
    const h = await scrypt(String(b.pw || ''), u.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) return fail(res, 401, '학번·이름 또는 비밀번호가 맞지 않아요.');
    const token = newSession(u); save();
    return send(res, 200, { token, user: pubUser(u) });
  }

  if (method === 'POST' && p === '/api/logout') {
    const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
    if (m && db.sessions[m[1]]) { delete db.sessions[m[1]]; save(); }
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/me') return user ? send(res, 200, { user: pubUser(user) }) : fail(res, 401, '로그인이 필요해요.');

  if (method === 'GET' && p === '/api/posts') {
    const list = boardOf(url.searchParams.get('board') || 'student', user, res);
    if (!list) return;
    return send(res, 200, { posts: list.slice().sort((a, b) => b.ts - a.ts).map(x => pubPost(x, user)) });
  }

  // 아래는 모두 로그인 필요
  if (p.startsWith('/api/posts')) {
    if (!user) return fail(res, 401, '로그인이 필요해요.');
    if (limited(ip, 'write', 30, 60000)) return fail(res, 429, '너무 빨라요. 잠시 뒤 다시 해 주세요.');

    if (method === 'POST' && p === '/api/posts') {
      const b = await readBody(req), list = boardOf(b.board, user, res);
      if (!list) return;
      const text = clip(b.text, 300);
      if (!text) return fail(res, 400, '내용을 적어 주세요.');
      list.unshift({ id: 'p' + uid(), to: clip(b.to, 20) || '모두에게', text, mode: b.mode === 'named' ? 'named' : 'anon', name: user.nick, uid: user.nick, ts: Date.now(), replies: [] });
      if (list.length > MAX_POSTS) list.length = MAX_POSTS;
      save();
      return send(res, 200, { ok: true });
    }

    const m = /^\/api\/posts\/([\w-]+)(\/replies)?$/.exec(p);
    if (m) {
      if (method === 'DELETE' && !m[2]) {
        const list = boardOf(url.searchParams.get('board'), user, res);
        if (!list) return;
        const i = list.findIndex(x => x.id === m[1]);
        if (i < 0) return fail(res, 404, '글을 찾을 수 없어요.');
        if (list[i].uid !== user.nick) return fail(res, 403, '내가 쓴 글만 삭제할 수 있어요.');
        list.splice(i, 1); save();
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && m[2]) {
        const b = await readBody(req), list = boardOf(b.board, user, res);
        if (!list) return;
        const post = list.find(x => x.id === m[1]);
        if (!post) return fail(res, 404, '글을 찾을 수 없어요.');
        const text = clip(b.text, 200);
        if (!text) return fail(res, 400, '답장 내용을 적어 주세요.');
        if (post.replies.length >= 200) return fail(res, 400, '이 글에는 더 이상 답장할 수 없어요.');
        post.replies.push({ id: 'r' + uid(), text, mode: b.mode === 'named' ? 'named' : 'anon', name: user.nick, uid: user.nick, ts: Date.now() });
        save();
        return send(res, 200, { ok: true });
      }
    }
  }
  return fail(res, 404, '없는 주소예요.');
}

/* ---------- 화면 파일 (index.html 하나만 내보내요) ---------- */
const PAGE = path.join(__dirname, 'index.html');
function serveStatic(req, res, url) {
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('페이지를 찾을 수 없어요.');
  }
  fs.readFile(PAGE, (err, buf) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) fail(res, e.message === 'too big' ? 413 : 400, '요청을 처리할 수 없어요.');
  }
}).listen(PORT, () => console.log(`성운고등학교 사이트가 켜졌어요: http://localhost:${PORT}`));

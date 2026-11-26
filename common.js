// 공통 설정: 연결 중개(시그널링) 서버와 방 코드 처리
// 영상 자체는 같은 와이파이 안에서 기기끼리 직접 오가고, 중개 서버는 처음 서로를 찾을 때만 쓴다.

const PHONECAM = (() => {
  const PREFIX = 'phonecam-v1-';
  const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 글자(0,o,1,l,i) 제외

  function newCode(len = 12) {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let s = '';
    for (const n of buf) s += CODE_CHARS[n % CODE_CHARS.length];
    return s;
  }

  function cleanCode(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  }

  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function sha256(text) {
    return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  }

  // 중개 서버에 등록하는 이름은 코드 자체가 아니라 코드의 해시다.
  // 그래서 서버나 다른 사람이 이 이름을 봐도 코드를 알 수 없다.
  async function peerId(code, kind = 'rx') {
    return PREFIX + kind + '-' + (await sha256('phonecam-id:' + kind + ':' + code)).slice(0, 32);
  }

  // 코드로 만든 비밀 키로 서명. 코드를 아는 기기끼리만 서로를 확인할 수 있다.
  async function sign(code, msg) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode('phonecam-key:' + code));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  }

  // 서명 비교: 길이와 모든 글자를 끝까지 비교해 비교 시간으로 정보가 새지 않게 한다
  function sameMac(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  function nonce() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return hex(b);
  }

  // 기본값: PeerJS 무료 공개 서버. 테스트용으로 ?srv=host:port 를 주면 그 서버를 쓴다.
  // 바깥 길 찾기(STUN)를 쓰지 않는다 → 같은 공유기 안의 주소로만 연결을 시도한다.
  function peerOptions() {
    const q = new URLSearchParams(location.search);
    const opts = { debug: 1, config: { iceServers: [] } };
    const srv = q.get('srv');
    // 테스트 서버는 이 컴퓨터(localhost)만 허용한다. 남이 만든 링크로 연결 서버를 바꿔치기하지 못하게.
    if (srv && /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(srv)) {
      const [host, port] = srv.split(':');
      opts.host = host;
      opts.port = Number(port || 9000);
      opts.path = '/';
      opts.secure = q.get('srvsecure') === '1';
    }
    return opts;
  }

  // 집 안(사설) 주소인지. 주소가 가려진 경우(.local 이름, 빈 값)는 판단 불가로 보고 통과시킨다.
  function isPrivateAddress(addr) {
    if (!addr) return true;
    const a = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
    if (a.endsWith('.local')) return true;
    const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (v4) {
      const [x, y] = [Number(v4[1]), Number(v4[2])];
      return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
    }
    if (a.includes(':')) return a === '::1' || a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd');
    return false;
  }

  // 실제로 연결된 경로를 확인한다: 바깥 경유(srflx·relay)이거나 공인 주소면 집 안 연결이 아니다.
  async function connectionPath(pc, tries = 4) {
    // 연결 직후에는 경로 정보가 아직 없을 수 있어 몇 번 다시 본다
    for (let i = 0; i < tries; i++) {
      const r = await readPath(pc);
      if (r.known || i === tries - 1) return r;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }

  async function readPath(pc) {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = pair || r; });
    if (!pair) return { known: false, local: true };
    const lc = stats.get(pair.localCandidateId) || {};
    const rc = stats.get(pair.remoteCandidateId) || {};
    const bad = (c) => c.candidateType === 'srflx' || c.candidateType === 'relay' || !isPrivateAddress(c.address || c.ip);
    return { known: true, local: !bad(lc) && !bad(rc), localType: lc.candidateType, remoteType: rc.candidateType, rtt: pair.currentRoundTripTime };
  }

  // 테스트용 서버 설정(srv)을 다른 페이지 주소에도 그대로 붙인다.
  function carryParams(url) {
    const q = new URLSearchParams(location.search);
    const u = new URL(url, location.href);
    const srv = q.get('srv');
    if (srv && /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(srv)) {
      u.searchParams.set('srv', srv);
      if (q.get('srvsecure') === '1') u.searchParams.set('srvsecure', '1');
    }
    return u.toString();
  }

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) {
      return null;
    }
  }

  return { newCode, cleanCode, peerId, sign, sameMac, nonce, peerOptions, isPrivateAddress, connectionPath, carryParams, store };
})();

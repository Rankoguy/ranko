// Robô de leitura de demos: para cada pessoa que ligou a leitura no site, busca as partidas novas,
// baixa a demo, conta os números e manda só as estatísticas para o Worker. Nunca imprime apelidos nem códigos.
import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';
import { decodeMatchShareCode } from 'csgo-sharecode';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { parseEvent, parseTicks, parseHeader } = require('@laihoe/demoparser2');

const env = (k) => {
  const v = (process.env[k] || '').trim();
  if (!v) { console.error(`FALTA o segredo ${k}`); process.exit(1); }
  return v;
};
const STEAM_API_KEY = env('STEAM_API_KEY');
const REFRESH = env('STEAM_REFRESH_TOKEN');
const WORKER = env('WORKER_URL').replace(/\/$/, '');
const ROBO = env('ROBO_SECRET');
const POR_PESSOA = Number(process.env.MAX_POR_PESSOA || 10);     // partidas novas por pessoa a cada execução
const LIMITE_MIN = Number(process.env.LIMITE_MINUTOS || 40);     // para antes de estourar o tempo do GitHub
const inicio = Date.now();
const log = (...a) => console.log(...a);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const comTempo = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

async function worker(caminho, opcoes = {}) {
  const r = await fetch(WORKER + caminho, { ...opcoes, headers: { 'x-robo': ROBO, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`Worker respondeu ${r.status} em ${caminho}`);
  return r.json();
}

const fontes = await worker('/interno/fontes');
log(`Pessoas com leitura ligada: ${fontes.length}`);
if (!fontes.length) process.exit(0);

// 1) quais partidas novas cada pessoa tem (a Steam entrega o código da seguinte a partir do último conhecido)
async function proximoCodigo(f, conhecido) {
  const u = new URL('https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1');
  u.search = new URLSearchParams({ key: STEAM_API_KEY, steamid: f.steam64, steamidkey: f.codigo_auth, knowncode: conhecido });
  const r = await fetch(u);
  if (r.status === 202) return { fim: true };
  if (r.status === 412 || r.status === 403) return { erro: 'Código de autenticação recusado pela Steam. Gere outro e cole de novo no site.' };
  if (!r.ok) throw new Error(`API da Steam ${r.status}`);
  const n = (await r.json())?.result?.nextcode;
  return !n || n === 'n/a' ? { fim: true } : { codigo: n };
}
const pessoas = []; // { f, fila:[codigo...], erro }
for (const f of fontes) {
  const p = { f, fila: [], erro: null };
  // na primeira leitura de cada pessoa, entra também a partida do próprio código colado (é o começo do histórico)
  if (f.primeira || process.env.INCLUIR_INICIAL === 'sim') p.fila.push(f.ultimo_codigo);
  try {
    let atual = f.ultimo_codigo;
    while (p.fila.length < POR_PESSOA) {
      const x = await proximoCodigo(f, atual);
      if (x.erro) { p.erro = x.erro; break; }
      if (x.fim) break;
      p.fila.push(x.codigo); atual = x.codigo;
    }
  } catch (e) { p.erro = 'Não deu para consultar a Steam agora.'; log('aviso:', e.message); }
  pessoas.push(p);
}
const total = pessoas.reduce((a, p) => a + p.fila.length, 0);
log(`Partidas novas encontradas: ${total}`);

const avancos = new Map(); // steam64 -> { ultimo_codigo, erro }
for (const p of pessoas) avancos.set(p.f.steam64, { steam64: p.f.steam64, ultimo_codigo: null, erro: p.erro });
if (!total) {
  await worker('/interno/partidas', { method: 'POST', body: JSON.stringify({ partidas: [], avancos: [...avancos.values()] }) });
  log('Nada novo. Fim.');
  process.exit(0);
}

// 2) a mesma partida pode estar na fila de várias pessoas: baixamos uma vez só
const porPartida = new Map(); // matchId -> { codigo, donos: [[steam64, posição na fila]] }
for (const p of pessoas) p.fila.forEach((codigo, i) => {
  const id = String(decodeMatchShareCode(codigo).matchId);
  if (!porPartida.has(id)) porPartida.set(id, { id, codigo, donos: [] });
  porPartida.get(id).donos.push([p.f.steam64, i]);
});

// 3) login da conta-robô
const steam = new SteamUser({ renewRefreshTokens: true });
const csgo = new GlobalOffensive(steam);
steam.on('error', (e) => { console.error('ERRO Steam:', e.message); process.exit(1); });
const logado = new Promise((res) => steam.once('loggedOn', res));
const noGC = new Promise((res) => csgo.once('connectedToGC', res));
steam.logOn({ refreshToken: REFRESH });
await comTempo(logado, 60000, 'não conseguiu entrar na Steam (o token de renovação pode ter expirado)');
steam.gamesPlayed([730]);
await comTempo(noGC, 90000, 'não conectou ao servidor do CS2');
log('✔ conta-robô conectada');

function acharUrlDemo(obj, vistos = new Set()) {
  if (!obj || typeof obj !== 'object' || vistos.has(obj)) return null;
  vistos.add(obj);
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && /\.dem(\.bz2)?$/i.test(v)) return v;
    const f = acharUrlDemo(v, vistos);
    if (f) return f;
  }
  return null;
}
function urlDaDemo(codigo, id) {
  return comTempo(new Promise((res) => {
    const aoReceber = (matches) => {
      const m = (matches || []).find((x) => String(x.matchid) === id) || (matches || [])[0];
      const url = acharUrlDemo(m);
      if (url) { csgo.removeListener('matchList', aoReceber); res({ url, horario: Number(m.matchtime) ? Number(m.matchtime) * 1000 : Date.now() }); }
    };
    csgo.on('matchList', aoReceber);
    csgo.requestGame(codigo);
  }), 45000, 'DEMO_INDISPONIVEL');
}

// 4) números por jogador de uma demo (só para quem tem a leitura ligada)
function estatisticas(arquivo, ids) {
  const mortes = parseEvent(arquivo, 'player_death', ['team_num'], ['total_rounds_played']);
  const danos = parseEvent(arquivo, 'player_hurt', ['team_num']);
  const cegos = parseEvent(arquivo, 'player_blind', ['team_num']);
  const fins = parseEvent(arquivo, 'round_end');
  const rounds = fins.length;
  if (!rounds) throw new Error('demo sem rodadas');
  const S = new Map(ids.map((id) => [id, { r: rounds, k: 0, d: 0, a: 0, hs: 0, dmg: 0, m1: 0, m2: 0, m3: 0, m4: 0, m5: 0, ff: 0, fa: 0, fl: 0, fas: 0, he: 0, ot: 0, og: 0, um: null, w: null, awp: 0, sm: 0, eb: 0, tk: 0, ud: 0, v2: 1, _r: {}, _n: 0, _u: 0 }]));
  const primeira = new Map(); // rodada -> primeira morte
  const ordenadas = [...mortes].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  for (const e of ordenadas) {
    const rd = e.total_rounds_played ?? 0;
    if (!primeira.has(rd) && e.attacker_steamid && e.attacker_steamid !== e.user_steamid) primeira.set(rd, e);
  }
  for (const [, e] of primeira) {
    const a = S.get(String(e.attacker_steamid)), v = S.get(String(e.user_steamid));
    if (e.attacker_team_num === e.user_team_num) continue;
    if (a) { a.ot++; a.og++; }
    if (v) v.ot++;
  }
  for (const e of mortes) {
    const v = S.get(String(e.user_steamid)); if (v) v.d++;
    const a = S.get(String(e.attacker_steamid));
    if (a && e.attacker_steamid !== e.user_steamid && e.attacker_team_num !== e.user_team_num) {
      a.k++; if (e.headshot) a.hs++;
      if (/awp/i.test(String(e.weapon))) a.awp++; // abates com a AWP (ajuda a sugerir a função)
      const rd = e.total_rounds_played ?? 0; a._r[rd] = (a._r[rd] || 0) + 1;
    }
    const as = S.get(String(e.assister_steamid));
    if (as && e.assister_steamid !== e.user_steamid && e.assister_team_num !== e.user_team_num) { as.a++; if (e.assistedflash) as.fas++; }
  }
  // troca (trade): matar, em até 5 segundos, quem acabou de matar um colega seu
  const JANELA = 5 * 64; // 5 s a 64 ticks
  for (let i = 0; i < ordenadas.length; i++) {
    const e2 = ordenadas[i];
    const a = S.get(String(e2.attacker_steamid));
    if (!a || e2.attacker_steamid === e2.user_steamid || e2.attacker_team_num === e2.user_team_num) continue;
    for (let j = i - 1; j >= 0 && (e2.tick || 0) - (ordenadas[j].tick || 0) <= JANELA; j--) {
      const e1 = ordenadas[j];
      if ((e1.total_rounds_played ?? 0) !== (e2.total_rounds_played ?? 0)) break;
      if (String(e1.attacker_steamid) === String(e2.user_steamid) && e1.user_team_num === e2.attacker_team_num && e1.user_steamid !== e2.attacker_steamid) { a.tk++; break; }
    }
  }
  for (const e of danos) {
    const a = S.get(String(e.attacker_steamid));
    if (!a || e.attacker_steamid === e.user_steamid) continue;
    if (e.attacker_team_num === e.user_team_num) { a.ff++; if (String(e.weapon).includes('hegrenade')) a.he += e.dmg_health || 0; }
    else {
      a.dmg += e.dmg_health || 0;
      if (/hegrenade|inferno|molotov|incgrenade/.test(String(e.weapon))) a.ud += e.dmg_health || 0; // dano de granada nos inimigos
    }
  }
  for (const e of cegos) {
    const a = S.get(String(e.attacker_steamid));
    if (!a || e.attacker_steamid === e.user_steamid) continue;
    if (e.attacker_team_num === e.user_team_num) a.fa++;
    else if ((e.blind_duration || 0) >= 1.5) a.eb++; // inimigo realmente cegado (mais de 1,5 s)
  }
  // flashes lançadas
  try {
    for (const e of parseEvent(arquivo, 'flashbang_detonate')) { const a = S.get(String(e.user_steamid)); if (a) a.fl++; }
  } catch { /* sem o dado, o item fica de fora */ }
  try {
    for (const e of parseEvent(arquivo, 'smokegrenade_detonate')) { const a = S.get(String(e.user_steamid)); if (a) a.sm++; }
  } catch { /* sem o dado, o item fica de fora */ }
  // vitória: time de cada jogador no fim de cada rodada contra o vencedor da rodada
  try {
    const ticks = fins.map((f) => f.tick).filter(Boolean);
    const lin = parseTicks(arquivo, ['team_num'], ticks);
    const venc = new Map(fins.map((f) => [f.tick, f.winner]));
    const cont = new Map(ids.map((id) => [id, { ganhas: 0, tot: 0 }]));
    for (const l of lin) {
      const c = cont.get(String(l.steamid)); if (!c) continue;
      const w = venc.get(l.tick);
      const eq = (w === 'T' || w === 2 ? 2 : w === 'CT' || w === 3 ? 3 : null);
      if (eq == null) continue;
      c.tot++; if (l.team_num === eq) c.ganhas++;
    }
    for (const [id, c] of cont) if (c.tot) S.get(id).w = c.ganhas > c.tot - c.ganhas ? 1 : c.ganhas === c.tot - c.ganhas ? null : 0;
  } catch { /* sem o dado, a vitória fica de fora */ }
  let mapa = null;
  try { const h = parseHeader(arquivo); mapa = String(h.map_name || h.mapName || h.map || '').replace(/^.*\//, '') || null; } catch { /* sem o mapa, a partida fica sem nome de mapa */ }
  const peso = [0, 1, 4, 9, 16, 25];
  const saida = {};
  for (const [id, s] of S) {
    if (!s.k && !s.d && !s.dmg) continue; // não estava nessa partida
    for (const k of Object.values(s._r)) { const n = Math.min(k, 5); s['m' + n]++; }
    delete s._r; delete s._n; delete s._u;
    s.dmg = Math.round(s.dmg); s.he = Math.round(s.he); s.ud = Math.round(s.ud); s.mapa = mapa;
    saida[id] = s;
  }
  return saida;
}

mkdirSync('saida', { recursive: true });
const partidas = [];
const ruins = new Map(); // matchId -> 'indisponivel' | 'falha'
let n = 0;
for (const pt of porPartida.values()) {
  n++;
  if ((Date.now() - inicio) / 60000 > LIMITE_MIN) { log('Tempo acabando: o resto fica para a próxima execução.'); break; }
  try {
    const { url, horario } = await urlDaDemo(pt.codigo, pt.id);
    pt.horario = horario;
    const bz = `saida/p${n}.dem.bz2`;
    // só baixa de endereços da Valve/Steam (o link vem de fora; não confiamos às cegas)
    const hostOk = /^https?:\/\/[a-z0-9.-]+\.(valve\.net|steamcontent\.com|steamserver\.net|steamcdn-a\.akamaihd\.net)\//i.test(url);
    if (!hostOk) throw new Error('DEMO_ENDERECO_ESTRANHO');
    const r = await fetch(url);
    if (r.status === 404 || r.status === 403) throw new Error('DEMO_INDISPONIVEL');
    if (!r.ok) throw new Error(`download ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > 600e6) throw new Error('DEMO_GRANDE_DEMAIS');
    writeFileSync(bz, Buffer.from(await r.arrayBuffer()));
    if (/\.bz2$/i.test(url)) execFileSync('bunzip2', ['-f', bz]);
    const arq = bz.replace(/\.bz2$/, '');
    // lê os números de todas as pessoas do painel que jogaram essa partida
    const todos = fontes.map((f) => f.steam64);
    const s = estatisticas(arq, todos);
    rmSync(arq, { force: true });
    pt.stats = s;
    for (const [id, st] of Object.entries(s)) partidas.push({ steam64: id, partida: pt.id, t: pt.horario, s: st });
    log(`✔ partida ${n}/${porPartida.size} lida (${Object.keys(s).length} pessoas do painel)`);
  } catch (e) {
    ruins.set(pt.id, e.message === 'DEMO_INDISPONIVEL' ? 'indisponivel' : 'falha');
    log(`✖ partida ${n}/${porPartida.size}: ${e.message === 'DEMO_INDISPONIVEL' ? 'demo indisponível (expirou)' : 'falhou, tentamos de novo na próxima'}`);
  }
}

// 5) cada pessoa avança na fila até a primeira partida que falhou por motivo temporário
for (const p of pessoas) {
  let ultimo = null;
  for (const codigo of p.fila) {
    const id = String(decodeMatchShareCode(codigo).matchId);
    const lida = [...porPartida.values()].find((x) => x.id === id);
    const ruim = ruins.get(id);
    if (ruim === 'falha' || (!ruim && !lida?.stats)) break;
    ultimo = codigo;
  }
  const a = avancos.get(p.f.steam64); a.ultimo_codigo = ultimo;
}
await worker('/interno/partidas', { method: 'POST', body: JSON.stringify({ partidas, avancos: [...avancos.values()] }) });
log(`Enviado: ${partidas.length} registros de partida.`);
steam.logOff();
await espera(500);
process.exit(0);

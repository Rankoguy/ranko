// Robô de leitura de demos: para cada pessoa que ligou a leitura no site, busca as partidas novas,
// baixa a demo, conta os números e manda só as estatísticas para o Worker. Nunca imprime apelidos nem códigos.
import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';
import { decodeMatchShareCode } from 'csgo-sharecode';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const dpLib = require('@laihoe/demoparser2');
// leitor em uso: o demoparser2 primeiro; quando ele não abrir a demo, o cs2parser (reserva)
let { parseEvent, parseTicks, parseHeader } = dpLib;
let libAtual = dpLib;
function usar(lib) { libAtual = lib; ({ parseEvent, parseTicks, parseHeader } = lib); }
import { lerEventos, calcular, compactar } from './analise.mjs';
import { lerComCs2 } from './leitor-cs2.mjs';
let VERSAO_LEITOR = '?';
try { VERSAO_LEITOR = require('@laihoe/demoparser2/package.json').version; } catch { /* sem a versão, segue */ }

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
// o log do GitHub Actions é PÚBLICO: tudo que sai nele passa por aqui e perde endereços, ids da Steam e códigos
const limpar = (x) => (typeof x === 'string' ? x
  .replace(/https?:\/\/\S+/g, '[endereço]')
  .replace(/CSGO(-[A-Za-z0-9]{5}){5}/g, '[código]')
  .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{5}-[A-Z0-9]{4}\b/g, '[código]')
  .replace(/\d{9,}/g, '#') : x);
const log = (...a) => console.log(...a.map(limpar));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const comTempo = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

async function worker(caminho, opcoes = {}) {
  const r = await fetch(WORKER + caminho, { ...opcoes, headers: { 'x-robo': ROBO, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`Worker respondeu ${r.status} em ${caminho}`);
  return r.json();
}

console.log(`Leitor de demos: demoparser2 ${VERSAO_LEITOR}`);
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
// quem tem o plano individual também tem o rating Premier lido (mesmo sem partida nova)
const querRating = fontes.filter((f) => f.quer_rating);
if (!total && !querRating.length) {
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
steam.on('error', (e) => { console.error('ERRO Steam:', limpar(String((e && e.message) || e))); process.exit(1); });
const logado = new Promise((res) => steam.once('loggedOn', res));
const noGC = new Promise((res) => csgo.once('connectedToGC', res));
steam.logOn({ refreshToken: REFRESH });
await comTempo(logado, 60000, 'não conseguiu entrar na Steam (o token de renovação pode ter expirado)');
steam.gamesPlayed([730]);
await comTempo(noGC, 90000, 'não conectou ao servidor do CS2');
log('✔ conta-robô conectada');

// Amizades com a conta-robô: o rating só é lido de quem é amigo. Aceita convite de quem já entrou no painel e
// convida (no máximo 5 por execução) quem ligou a leitura e ainda não é amigo. Nunca imprime ids.
const REL = SteamUser.EFriendRelationship;
const estados = {};
try {
  await espera(5000); // a lista de amigos chega logo depois do login
  const conhecidos = new Set(((await worker('/interno/conhecidos')) || []).map(String));
  let aceitos = 0, convites = 0, semConvite = false;
  for (const [id, rel] of Object.entries(steam.myFriends || {})) {
    if (Number(rel) === REL.RequestRecipient && conhecidos.has(id)) {
      try { await steam.addFriend(id); aceitos++; await espera(1000); } catch (e) { log('  (não aceitou um convite:', String((e && e.message) || e).slice(0, 80), ')'); }
    }
  }
  if (aceitos) await espera(3000);
  for (const f of fontes) {
    const rel = Number((steam.myFriends || {})[f.steam64] || 0);
    if (rel === REL.Friend) estados[f.steam64] = 'amigo';
    else if (rel === REL.RequestInitiator) estados[f.steam64] = 'convidado';
    else if (rel === REL.None && convites < 5 && !semConvite) {
      try { await steam.addFriend(f.steam64); convites++; estados[f.steam64] = 'convidado'; await espera(1500); }
      catch (e) {
        const msg = String((e && e.message) || e);
        estados[f.steam64] = 'nenhum';
        // demora da Steam não é bloqueio: segue para a próxima pessoa (o estado real aparece na próxima rodada)
        if (!/timed out|timeout/i.test(msg)) semConvite = true;
        log('  (a conta-robô não conseguiu enviar convite:', msg.slice(0, 80), ')');
      }
    } else estados[f.steam64] = 'nenhum';
  }
  await worker('/interno/amizades', { method: 'POST', body: JSON.stringify({ estados }) });
  log(`Amizades: ${aceitos} convite(s) aceito(s), ${convites} enviado(s)`);
} catch (e) { log('aviso (amizades):', String((e && e.message) || e).slice(0, 120)); }

// Rating Premier (só de quem tem o plano individual). Nunca imprime o número: o log do GitHub é público.
const ratings = [];
function rankingsDe(perfil) {
  // junta todas as entradas de ranking (rank_type_id + rank_id) que a Valve devolveu no perfil
  const achados = [];
  (function varrer(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 4) return;
    if (Array.isArray(o)) { o.forEach((x) => varrer(x, d + 1)); return; }
    if ('rank_type_id' in o && 'rank_id' in o) achados.push(o);
    Object.values(o).forEach((x) => varrer(x, d + 1));
  })(perfil);
  return achados;
}
function premierDe(perfil) {
  const p = rankingsDe(perfil).find((x) => Number(x.rank_type_id) === 11);
  return p ? Number(p.rank_id) : null;
}
const DEP = process.env.DEPURAR_RATING === 'sim';
async function perfilDe(f) {
  // a Valve só responde para amigo da conta Ranko; quem ainda não é amigo é pulado (sem esperar o tempo limite)
  const lista = steam.myFriends || {};
  const amigo = lista[f.steam64] === SteamUser.EFriendRelationship.Friend;
  if (Object.keys(lista).length && !amigo) return 'nao_amigo';
  if (DEP) log(`  (rating: amizade com a conta-robô: ${amigo ? 'SIM' : 'não confirmada'})`);
  try {
    const perfil = await comTempo(new Promise((res) => { csgo.requestPlayersProfile(f.steam64, res); }), 30000, 'sem resposta da Valve em 30 s');
    if (DEP) log('  (rating: a Valve respondeu ao pedido)');
    return perfil || {};
  } catch (e) {
    if (DEP) log(`  (rating: o pedido falhou: ${String((e && e.message) || e).slice(0, 120)})`);
    return null;
  }
}
let naoAmigos = 0;
for (const f of querRating) {
  const perfil = await perfilDe(f);
  if (perfil === 'nao_amigo') { naoAmigos++; continue; }
  if (!perfil) log('  (rating indisponível para uma pessoa)');
  else {
    const rt = premierDe(perfil);
    if (Number.isInteger(rt) && rt > 0) ratings.push({ steam64: f.steam64, rating: rt });
    else if (DEP) log('  (rating: o perfil não trouxe entrada Premier. Campos:', Object.keys(perfil).join(', '), '| tipos de ranking:', rankingsDe(perfil).map((x) => x.rank_type_id).join(', ') || 'nenhum', ')');
  }
  await espera(1500);
}
if (naoAmigos) log(`  (${naoAmigos} pessoa(s) ainda não são amigas da conta Ranko: sem rating)`);
log(`Ratings lidos: ${ratings.length} de ${querRating.length - naoAmigos}`);

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
      if (DEP && m) { // só nomes de campos (nunca valores): para descobrir se a Valve informa o modo e o rank da partida
        const ch = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : '-');
        const ult = Array.isArray(m.roundstatsall) ? m.roundstatsall[m.roundstatsall.length - 1] : null;
        log('  (partida: campos', ch(m), '| última rodada:', ch(ult), '| reserva:', ch(ult && ult.reservation), ')');
      }
      if (url) { csgo.removeListener('matchList', aoReceber); res({ url, horario: Number(m.matchtime) ? Number(m.matchtime) * 1000 : Date.now() }); }
    };
    csgo.on('matchList', aoReceber);
    csgo.requestGame(codigo);
  }), 45000, 'DEMO_INDISPONIVEL');
}

// 4) números por jogador de uma demo (só para quem tem a leitura ligada)
function etapa(nome, fn) { try { return fn(); } catch (e) { throw new Error(`${nome}: ${String((e && e.message) || e)}`); } }
function estatisticas(arquivo, ids) {
  const fins = etapa('fim de rodada', () => parseEvent(arquivo, 'round_end'));
  const rounds = fins.length;
  if (!rounds) throw new Error('demo sem rodadas');
  // mortes: o número da rodada normalmente vem do jogo; se essa leitura falhar, contamos pelos fins de rodada
  let mortes;
  try { mortes = parseEvent(arquivo, 'player_death', ['team_num'], ['total_rounds_played']); }
  catch (e1) {
    mortes = etapa('mortes', () => parseEvent(arquivo, 'player_death', ['team_num']));
    const tf = fins.map((f) => f.tick || 0).sort((a, b) => a - b);
    for (const m of mortes) { let r = 0; while (r < tf.length && tf[r] < (m.tick || 0)) r++; m.total_rounds_played = r; }
  }
  const danos = etapa('dano', () => parseEvent(arquivo, 'player_hurt', ['team_num']));
  const cegos = etapa('cegueira', () => parseEvent(arquivo, 'player_blind', ['team_num']));
  const S = new Map(ids.map((id) => [id, { r: rounds, k: 0, d: 0, a: 0, hs: 0, dmg: 0, m1: 0, m2: 0, m3: 0, m4: 0, m5: 0, ff: 0, fa: 0, fl: 0, fas: 0, he: 0, ot: 0, og: 0, um: null, w: null, awp: 0, sm: 0, eb: 0, tk: 0, ud: 0, v2: 1,
    // coleta v3 (14/11): precisão, granadas que funcionaram, rounds de 2+ abates vivo e o alastro em contagens
    v3: 1, tf: 0, ta: 0, heb: 0, mob: 0, ks2: 0, ffx: 0, fax: 0, hex: 0, uct: 0, ugn: 0,
    // coleta v4 (14/11): mira no modelo do Leetify. hc = acertos na cabeça; sp/sa = tiros em spray e os que acertaram;
    // csn/csb = primeiros tiros dados logo depois de andar e quantos deles saíram com o boneco já parado (contra-strafe)
    // coleta v5 (14/11, noite): definições do Leetify. hta/hc = acertos (sem escopeta) e na cabeça; ea/eh = tiros em
    // combate e os que acertaram; csn/csb = tiros de rifle/sniper em combate e os que saíram parado. vc = versão da coleta.
    v4: 1, v5: 1, vc: 5, hta: 0, hc: 0, sp: 0, sa: 0, csn: 0, csb: 0, ea: 0, eh: 0,
    _r: {}, _m: {}, _n: 0, _u: 0 }]));
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
    if (v) v._m[e.total_rounds_played ?? 0] = 1; // morreu nessa rodada
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
  // ---- coleta v3 ----
  const NAO_ARMA = /knife|bayonet|grenade|flashbang|molotov|incgrenade|inferno|decoy|smoke|c4|taser|world/i;
  const nomeArma = (w) => String(w || '').replace(/^weapon_/, '').toLowerCase();
  const ehArma = (w) => { const n = nomeArma(w); return !!n && !NAO_ARMA.test(n); };
  // mira: tiros disparados com arma de fogo e tiros que acertaram um inimigo
  try { for (const e of parseEvent(arquivo, 'weapon_fire')) { const s = S.get(String(e.user_steamid)); if (s && ehArma(e.weapon)) s.tf++; } }
  catch { /* sem os tiros: a mira usa só o headshot */ }
  const heInim = new Map(), heAmigo = new Map(), fogos = new Map();
  for (const e of danos) {
    const id = String(e.attacker_steamid), a = S.get(id);
    if (!a || e.attacker_steamid === e.user_steamid) continue;
    const w = nomeArma(e.weapon), dano = e.dmg_health || 0, amigo = e.attacker_team_num === e.user_team_num;
    if (amigo) {
      if (ehArma(w) && dano >= 15) a.ffx++; // fogo amigo: cada tiro que tirou 15 ou mais de vida de um colega
      if (/hegrenade/.test(w)) heAmigo.set(id + '|' + e.tick, (heAmigo.get(id + '|' + e.tick) || 0) + dano);
    } else {
      if (ehArma(w)) a.ta++;
      if (/hegrenade/.test(w)) heInim.set(id + '|' + e.tick, (heInim.get(id + '|' + e.tick) || 0) + dano);
      if (/inferno|molotov|incgrenade/.test(w)) (fogos.get(id) || fogos.set(id, []).get(id)).push({ t: e.tick || 0, d: dano });
    }
  }
  // cada HE explode num tick: soma o dano daquele tick
  for (const [k, d] of heInim) if (d >= 50) S.get(k.split('|')[0]).heb++;
  for (const [k, d] of heAmigo) if (d >= 15) S.get(k.split('|')[0]).hex++;
  // molotov queima por uns 7 s: danos do mesmo jogador dentro de 8 s contam como a mesma molotov
  for (const [id, L] of fogos) {
    L.sort((x, y) => x.t - y.t);
    let ini = null, soma = 0;
    const fecha = () => { if (ini != null && soma >= 30) S.get(id).mob++; };
    for (const x of L) { if (ini == null || x.t - ini > 8 * 64) { fecha(); ini = x.t; soma = 0; } soma += x.d; }
    fecha();
  }
  // cegador do time: cada flash (mesmo tick) que cegou um colega por 1,5 s ou mais conta 1
  const flAmigo = new Set();
  for (const e of cegos) {
    if (!S.has(String(e.attacker_steamid)) || e.attacker_steamid === e.user_steamid) continue;
    if (e.attacker_team_num === e.user_team_num && (e.blind_duration || 0) >= 1.5) flAmigo.add(String(e.attacker_steamid) + '|' + e.tick);
  }
  for (const k of flAmigo) S.get(k.split('|')[0]).fax++;
  // ---- coleta v4: mira ----
  try { miraV4(arquivo, S, danos, ehArma, nomeArma); } catch { for (const x of S.values()) { x.v4 = 0; x.v5 = 0; x.vc = 3; } /* sem esses números, a mira usa o que tiver */ }
  // comprou à toa: morreu com 3 granadas ou mais na mão
  try {
    const comInv = mortes.filter((e) => S.has(String(e.user_steamid)));
    let inv = null;
    if (comInv.length && comInv.every((e) => e.granadas == null)) {
      // leitor principal: inventário um tick antes da morte
      const L = parseTicks(arquivo, ['inventory'], [...new Set(comInv.map((e) => (e.tick || 1) - 1))]);
      inv = new Map(L.map((l) => [String(l.steamid) + '|' + l.tick, (Array.isArray(l.inventory) ? l.inventory : []).filter((n) => /grenade|flashbang|molotov|incendiary|decoy/i.test(String(n))).length]));
    }
    const hist = [0, 0, 0, 0];
    Object.defineProperty(S, '_hist', { value: hist, enumerable: false });
    for (const e of comInv) {
      const s = S.get(String(e.user_steamid));
      const g = e.granadas != null ? e.granadas : inv ? inv.get(String(e.user_steamid) + '|' + ((e.tick || 1) - 1)) : null;
      if (g == null) continue;
      s.ugn++;
      hist[Math.min(g, 3)]++;
      if (g >= 3) s.uct++;
    }
  } catch { /* sem o inventário, o "comprou à toa" fica sem dado */ }
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
  Object.defineProperty(saida, '_ev', { value: { mortes, danos, fins }, enumerable: false });
  Object.defineProperty(saida, '_hist', { value: S._hist || null, enumerable: false });
  Object.defineProperty(saida, '_cs', { value: S._cs || null, enumerable: false });
  for (const [id, s] of S) {
    if (!s.k && !s.d && !s.dmg) continue; // não estava nessa partida
    for (const k of Object.values(s._r)) { const n = Math.min(k, 5); s['m' + n]++; }
    for (const [rd, k] of Object.entries(s._r)) if (k >= 2 && !s._m[rd]) s.ks2++; // 2+ abates e saiu vivo do round
    delete s._r; delete s._m; delete s._n; delete s._u;
    s.dmg = Math.round(s.dmg); s.he = Math.round(s.he); s.ud = Math.round(s.ud); s.mapa = mapa;
    saida[id] = s;
  }
  return saida;
}

// ---- coleta v4: estatísticas de mira no modelo do Leetify ----
// Velocidade máxima de cada arma (unidades por segundo). O tiro só é preciso com o boneco a 34% dela ou menos.
const VEL_MAX = { ak47: 215, m4a1: 225, m4a1_silencer: 225, famas: 220, galilar: 215, aug: 220, sg556: 210, awp: 200, ssg08: 230,
  deagle: 230, revolver: 220, glock: 240, usp_silencer: 240, hkp2000: 240, p250: 240, fiveseven: 240, tec9: 240, cz75a: 240, elite: 240,
  mp9: 240, mac10: 240, mp7: 220, mp5sd: 235, ump45: 230, p90: 230, bizon: 240, negev: 150, m249: 195,
  nova: 220, xm1014: 215, mag7: 225, sawedoff: 210, g3sg1: 215, scar20: 215 };
const RIFLE = /^(ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556)$/;
const ESCOPETA = /^(nova|xm1014|mag7|sawedoff)$/;
// contra-strafe só com as armas que erram muito andando: rifles, AWP/Scout/automáticas de sniper e Desert Eagle.
// Com submetralhadora e pistola leve, atirar andando de perto é jogada válida (conferência de 14/11: 1 em 4 tiros era assim).
const CONTRA = /^(ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556|awp|ssg08|g3sg1|scar20)$/;
function miraV4(arquivo, S, danos, ehArma, nomeArma) {
  // coleta v5 (14/11, noite): as definições do Leetify, o mais perto que dá sem ler quem estava vendo quem.
  // acertos em inimigos com arma de fogo, por jogador e tick (cada tiro acerta no mesmo tick em que sai)
  const acertos = new Map();
  for (const e of danos) {
    const id = String(e.attacker_steamid), s = S.get(id);
    if (!s || e.attacker_steamid === e.user_steamid || e.attacker_team_num === e.user_team_num || !ehArma(e.weapon)) continue;
    (acertos.get(id) || acertos.set(id, new Set()).get(id)).add(e.tick || 0);
    if (ESCOPETA.test(nomeArma(e.weapon))) continue; // cada bago de escopeta é um acerto: fica fora da conta da cabeça
    // precisão na cabeça: acertos na cabeça / acertos (no CS2 o pescoço conta como cabeça: hitgroup 1 ou 8)
    s.hta++;
    const hg = e.hitgroup;
    if (hg === 1 || hg === 8 || /head|neck/i.test(String(hg ?? ''))) s.hc++;
  }
  const tiros = new Map();
  for (const e of parseEvent(arquivo, 'weapon_fire')) {
    const id = String(e.user_steamid);
    if (!S.has(id) || !ehArma(e.weapon)) continue;
    (tiros.get(id) || tiros.set(id, []).get(id)).push({ t: e.tick || 0, w: nomeArma(e.weapon), v0: e._v0 });
  }
  const acertou = (id, t) => { const A = acertos.get(id); return !!A && (A.has(t) || A.has(t + 1)); };
  // "em combate": algum tiro dele acertou um inimigo até 1 s antes ou depois. É o substituto do "inimigo visto" do
  // Leetify: deixa de fora tiro em smoke, spam e prefire.
  const lista = new Map([...acertos].map(([id, A]) => [id, [...A].sort((a, b) => a - b)]));
  const emCombate = (id, t) => { const L = lista.get(id); if (!L) return false; for (const h of L) { if (h >= t - 64 && h <= t + 64) return true; if (h > t + 64) break; } return false; };
  const parar = []; // tiros de rifle e sniper em combate: contra-strafe (como no Leetify, "rifles e AWP")
  for (const [id, L] of tiros) {
    L.sort((a, b) => a.t - b.t);
    const s = S.get(id);
    // spray: 3 tiros ou mais de rifle em sequência (até 12 ticks entre um e outro, com a mesma arma)
    let seq = [];
    const fecha = () => {
      if (seq.length >= 3) {
        const n = seq.filter((x) => acertou(id, x.t)).length;
        if (n) { s.sp += seq.length; s.sa += n; } // spray que não acertou ninguém (smoke, spam) fica de fora
      }
      seq = [];
    };
    for (const x of L) {
      if (RIFLE.test(x.w)) { if (seq.length && (x.t - seq[seq.length - 1].t > 12 || x.w !== seq[seq.length - 1].w)) fecha(); seq.push(x); }
      else fecha();
      if (ESCOPETA.test(x.w) || !emCombate(id, x.t)) continue;
      // precisão em combate: dos tiros dados em combate, quantos acertaram
      s.ea++; if (acertou(id, x.t)) s.eh++;
      if (CONTRA.test(x.w)) parar.push({ id, ...x });
    }
    fecha();
  }
  // contra-strafe: dos tiros de rifle e sniper em combate, quantos saíram com o boneco lento o bastante para ser preciso
  let vel0 = (x) => x.v0;
  if (parar.length && parar.every((x) => x.v0 == null)) {
    // leitor principal: posição do boneco no tick do tiro e no anterior
    const ticks = new Set();
    for (const x of parar) for (const d of [0, 1]) if (x.t - d > 0) ticks.add(x.t - d);
    const pos = new Map();
    try { for (const l of parseTicks(arquivo, ['X', 'Y'], [...ticks])) if (typeof l.X === 'number') pos.set(String(l.steamid) + '|' + l.tick, l); }
    catch { /* sem a posição, o contra-strafe fica sem dado */ }
    vel0 = (x) => { const a = pos.get(x.id + '|' + x.t), b = pos.get(x.id + '|' + (x.t - 1)); return a && b ? Math.hypot(a.X - b.X, a.Y - b.Y) * 64 : null; };
  }
  const hcs = [0, 0, 0, 0]; // conferência: velocidade no tiro (parado, quase parando, freando, correndo)
  for (const x of parar) {
    const v0 = vel0(x);
    if (v0 == null || v0 > 400) continue; // sem posição ou teleporte: fica de fora
    const mx = VEL_MAX[x.w] || 230, lim = 0.34 * mx;
    const s = S.get(x.id); s.csn++; if (v0 <= lim) s.csb++;
    hcs[v0 <= lim ? 0 : v0 <= 1.5 * lim ? 1 : v0 <= 0.7 * mx ? 2 : 3]++;
  }
  Object.defineProperty(S, '_cs', { value: hcs, enumerable: false, configurable: true });
}

// 4b) quadro completo da partida: os 10 jogadores (inclusive quem não está no painel), placar e KAST.
// "eq" é 0 ou 1: quem estava do lado T no começo da partida é o time 0, o outro é o time 1 (vale a partida toda, mesmo com a troca de lado).
function completa(arquivo, ev) {
  const { mortes, danos, fins } = ev;
  const ordem = [...fins].filter((f) => f.tick).sort((a, b) => a.tick - b.tick);
  const rounds = ordem.length;
  if (!rounds) throw new Error('demo sem rodadas');
  const idx = new Map(ordem.map((f, i) => [f.tick, i]));
  const lado = (w) => (w === 'T' || w === 2 ? 2 : w === 'CT' || w === 3 ? 3 : null);
  const lin = parseTicks(arquivo, ['name', 'team_num'], ordem.map((f) => f.tick));
  const porTick = new Map();
  const J = new Map();
  for (const l of lin) {
    const id = String(l.steamid || '');
    if (!/^\d{17}$/.test(id) || (l.team_num !== 2 && l.team_num !== 3)) continue;
    (porTick.get(l.tick) || porTick.set(l.tick, []).get(l.tick)).push({ id, lado: l.team_num });
    let j = J.get(id);
    if (!j) { j = { id, nome: '', eq: null, k: 0, d: 0, a: 0, dmg: 0, hs: 0, m2: 0, m3: 0, m4: 0, m5: 0, _ka: new Set(), _mortos: new Set(), _r: {}, _pres: new Set() }; J.set(id, j); }
    if (l.name) j.nome = String(l.name).slice(0, 40);
    j._pres.add(idx.get(l.tick));
  }
  // times: no primeiro registro, T = time 0 e CT = time 1; quem chega depois entra no time dos que estão do mesmo lado que ele
  for (const f of ordem) {
    const linhas = porTick.get(f.tick) || [];
    for (const x of linhas) { const j = J.get(x.id); if (j.eq == null && f === ordem[0]) j.eq = x.lado === 2 ? 0 : 1; }
    const ladoDoTime0 = (linhas.find((x) => J.get(x.id).eq === 0) || {}).lado
      ?? ((linhas.find((x) => J.get(x.id).eq === 1) || {}).lado === 2 ? 3 : (linhas.find((x) => J.get(x.id).eq === 1) || {}).lado === 3 ? 2 : null);
    f._l0 = ladoDoTime0;
    for (const x of linhas) { const j = J.get(x.id); if (j.eq == null && ladoDoTime0 != null) j.eq = x.lado === ladoDoTime0 ? 0 : 1; }
  }
  const placar = [0, 0];
  for (const f of ordem) {
    const w = lado(f.winner); if (w == null || f._l0 == null) continue;
    placar[w === f._l0 ? 0 : 1]++;
  }
  const ordenadas = [...mortes].filter((e) => (e.total_rounds_played ?? 0) < rounds).sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const JANELA = 5 * 64;
  for (let i = 0; i < ordenadas.length; i++) {
    const e = ordenadas[i], rd = e.total_rounds_played ?? 0;
    const v = J.get(String(e.user_steamid)), a = J.get(String(e.attacker_steamid)), as = J.get(String(e.assister_steamid));
    const inimigo = e.attacker_team_num !== e.user_team_num;
    const suicidio = String(e.attacker_steamid) === String(e.user_steamid);
    if (v) { v.d++; v._mortos.add(rd); }
    if (a && !suicidio && inimigo) { a.k++; if (e.headshot) a.hs++; a._ka.add(rd); a._r[rd] = (a._r[rd] || 0) + 1; }
    if (as && String(e.assister_steamid) !== String(e.user_steamid) && e.assister_team_num !== e.user_team_num) { as.a++; as._ka.add(rd); }
    if (v && inimigo && !suicidio) { // trocado: um colega do morto mata o assassino em até 5 s
      for (let k = i + 1; k < ordenadas.length && (ordenadas[k].tick || 0) - (e.tick || 0) <= JANELA; k++) {
        const e2 = ordenadas[k];
        if ((e2.total_rounds_played ?? 0) !== rd) break;
        if (String(e2.user_steamid) === String(e.attacker_steamid) && e2.attacker_team_num === e.user_team_num && String(e2.attacker_steamid) !== String(e2.user_steamid)) { v._ka.add(rd); break; }
      }
    }
  }
  for (const e of danos) {
    const a = J.get(String(e.attacker_steamid));
    if (!a || String(e.attacker_steamid) === String(e.user_steamid) || e.attacker_team_num === e.user_team_num) continue;
    a.dmg += e.dmg_health || 0;
  }
  const jog = [];
  for (const j of J.values()) {
    if (j.eq == null || (!j.k && !j.d && !j.dmg && !j.a)) continue;
    for (const k of Object.values(j._r)) j['m' + Math.min(k, 5)]++;
    let ka = 0; for (const r of j._pres) if (j._ka.has(r) || !j._mortos.has(r)) ka++; // K, A, sobreviveu ou foi trocado
    jog.push({ id: j.id, nome: j.nome || 'Jogador', eq: j.eq, r: j._pres.size, k: j.k, d: j.d, a: j.a, dmg: Math.round(j.dmg), hs: j.hs, ka, m2: j.m2, m3: j.m3, m4: j.m4, m5: j.m5 });
  }
  if (jog.length < 2) throw new Error('quadro vazio');
  let mapa = null;
  try { const h = parseHeader(arquivo); mapa = String(h.map_name || h.mapName || h.map || '').replace(/^.*\//, '') || null; } catch { /* sem mapa */ }
  return { mapa, rounds, placar, jog };
}

const CONFERIR = process.env.CONFERIR === 'sim';

mkdirSync('saida', { recursive: true });
const partidas = [];
const completas = [];
const analises = [];
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
    const hostOk = (u) => /^https?:\/\/[a-z0-9.-]+\.(valve\.net|steamcontent\.com|steamserver\.net|steamcdn-a\.akamaihd\.net)\//i.test(u);
    if (!hostOk(url)) throw new Error('DEMO_ENDERECO_ESTRANHO');
    const r = await fetch(url);
    // se o servidor redirecionar, o destino final também tem que ser da Valve
    if (r.url && !hostOk(r.url)) throw new Error('DEMO_ENDERECO_ESTRANHO');
    if (r.status === 404 || r.status === 403) throw new Error('DEMO_INDISPONIVEL');
    if (!r.ok) throw new Error(`download ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > 600e6) throw new Error('DEMO_GRANDE_DEMAIS');
    writeFileSync(bz, Buffer.from(await r.arrayBuffer()));
    if (/\.bz2$/i.test(url)) execFileSync('bunzip2', ['-f', bz]);
    const arq = bz.replace(/\.bz2$/, '');
    // lê os números de todas as pessoas do painel que jogaram essa partida
    const todos = fontes.map((f) => f.steam64);
    let s;
    usar(dpLib);
    try { s = estatisticas(arq, todos); }
    catch (e0) {
      // o demoparser2 não abriu: tenta o leitor reserva antes de desistir
      try {
        usar(await lerComCs2(arq));
        s = estatisticas(arq, todos);
        log(`  (partida ${n}: lida pelo leitor reserva cs2parser)`);
      } catch (e1) {
        log(`  (leitor reserva também falhou: ${String((e1 && e1.message) || e1).replace(/\d{9,}/g, '#').slice(0, 80)})`);
        usar(dpLib);
        const e = e0;
      // diagnóstico da demo que o leitor não conseguiu abrir: só números de versão e tamanho (nada de nomes de servidor ou jogadores)
      try {
        const h = parseHeader(arq) || {};
        const v = Object.entries(h).filter(([k, x]) => /protocol|build|patch|version/i.test(k) && !/guid|name/i.test(k) && (typeof x === 'number' || (typeof x === 'string' && x.length <= 20))).map(([k, x]) => `${k}=${x}`).join(' ');
        log(`  (demo que falhou: ${v || 'sem campos de versão'}; ${Math.round(statSync(arq).size / 1e6)} MB)`);
      } catch { /* sem o cabeçalho, segue */ }
      throw e;
      }
    }
    // quadro dos 10 jogadores (placar, KAST, quem não está no painel). Se falhar, a partida segue só com os números do painel.
    try {
      const q = completa(arq, s._ev);
      completas.push({ partida: pt.id, t: pt.horario, ...q });
      if (CONFERIR) { // só totais por time: nada de nomes nem ids no log público
        const tot = [0, 1].map((eq) => q.jog.filter((x) => x.eq === eq).reduce((a, x) => ({ j: a.j + 1, k: a.k + x.k, d: a.d + x.d }), { j: 0, k: 0, d: 0 }));
        const d = new Date((pt.horario || 0) - 3 * 3600e3);
        log(`  Conferência: ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}h, ${q.mapa || 'mapa ?'}, ${q.rounds} rodadas, placar ${q.placar[0]} x ${q.placar[1]} | time 1: ${tot[0].j} jogadores, ${tot[0].k} abates, ${tot[0].d} mortes | time 2: ${tot[1].j} jogadores, ${tot[1].k} abates, ${tot[1].d} mortes | do painel: ${Object.values(s).map((x) => x.k + '/' + x.d).join(', ') || 'ninguém'}`);
        // coleta nova (v3): só somas de quem é do painel, para conferir se os dados chegaram
        const v = Object.values(s).reduce((t, x) => { for (const c of ['tf', 'ta', 'heb', 'mob', 'ks2', 'ffx', 'fax', 'hex', 'uct', 'ugn', 'd']) t[c] = (t[c] || 0) + (x[c] || 0); return t; }, {});
        log(`  Coleta nova: tiros ${v.tf || 0}, acertos ${v.ta || 0}, HE boas ${v.heb || 0}, molotov boas ${v.mob || 0}, rounds de 2+ abates vivo ${v.ks2 || 0}, fogo amigo ${v.ffx || 0}, flash em amigo ${v.fax || 0}, HE em amigo ${v.hex || 0}, morreu com 3+ granadas ${v.uct || 0} (inventário lido em ${v.ugn || 0} de ${v.d || 0} mortes)`);
        const m4 = Object.values(s).reduce((t, x) => { for (const c of ['hta', 'hc', 'ea', 'eh', 'sp', 'sa', 'csn', 'csb']) t[c] = (t[c] || 0) + (x[c] || 0); return t; }, {});
        log(`  Mira nova (painel): na cabeça ${m4.hc || 0} de ${m4.hta || 0} acertos, tiros em combate ${m4.ea || 0} (acertaram ${m4.eh || 0}), tiros em spray ${m4.sp || 0} (acertaram ${m4.sa || 0}), tiros de rifle/sniper em combate ${m4.csn || 0} (saíram parado ${m4.csb || 0})` + (s._cs ? ` | velocidade no tiro: parado ${s._cs[0]}, quase parando ${s._cs[1]}, freando ${s._cs[2]}, correndo ${s._cs[3]}` : ''));
        const h = s._hist, dg = libAtual && libAtual.diag;
        log(`  Granadas na hora da morte (painel): 0 = ${h ? h[0] : '?'}, 1 = ${h ? h[1] : '?'}, 2 = ${h ? h[2] : '?'}, 3+ = ${h ? h[3] : '?'}` + (dg ? ` | leitor reserva (fonte: ${dg.fonte}): ${dg.fotos} fotos de inventário (${dg.fotosComGranada} com granada), granadas pegas ${dg.pegou}, lançadas ${dg.lancou}, mortes com 3+ pela foto ${dg.morte3Foto} e pela contagem ${dg.morte3Conta} (todos os 10 jogadores)` : ''));
      }
    } catch (e) { log(`  (quadro completo indisponível nesta partida: ${String((e && e.message) || e).slice(0, 60)})`); }
    // Ranko Analyst: resumo por round (só eventos; sem posição por tick). Se falhar, a partida segue só com as estatísticas.
    try {
      const an = calcular(lerEventos(libAtual, arq));
      if (an) analises.push({ partida: pt.id, t: pt.horario, a: compactar(an) });
    } catch (e) { log('  (análise de rounds indisponível nesta partida)'); }
    usar(dpLib);
    rmSync(arq, { force: true });
    pt.stats = s;
    for (const [id, st] of Object.entries(s)) partidas.push({ steam64: id, partida: pt.id, t: pt.horario, s: st });
    log(`✔ partida ${n}/${porPartida.size} lida (${Object.keys(s).length} pessoas do painel)`);
  } catch (e) {
    ruins.set(pt.id, e.message === 'DEMO_INDISPONIVEL' ? 'indisponivel' : 'falha');
    // o motivo vai para o log sem endereços nem números longos (códigos e ids), que o log é público
    const motivo = String((e && e.message) || e).replace(/https?:\/\/\S+/g, '[endereço]').replace(/\d{9,}/g, '#').replace(/\s+/g, ' ').slice(0, 110);
    log(`✖ partida ${n}/${porPartida.size}: ${e.message === 'DEMO_INDISPONIVEL' ? 'demo indisponível (expirou)' : 'falhou (' + motivo + '), tentamos de novo na próxima'}`);
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
if (CONFERIR) { log('Conferência concluída. Nada foi gravado e a fila não andou.'); steam.logOff(); await espera(500); process.exit(0); }
await worker('/interno/partidas', { method: 'POST', body: JSON.stringify({ partidas, completas, analises, ratings, avancos: [...avancos.values()] }) });
log(`Enviado: ${partidas.length} registros de partida e ${completas.length} quadro(s) completo(s).`);
steam.logOff();
await espera(500);
process.exit(0);

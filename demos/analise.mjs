// Ranko Analyst: lê os eventos de uma demo e calcula diagnósticos por round.
// Sem posição por tick: só eventos (mortes, fim de round, bomba) e uma amostra
// do elenco no fim do tempo de congelamento de cada round (time, dinheiro, equipamento).
import { createRequire } from 'node:module';

const JANELA_TRADE_S = 5;          // trade = um colega mata o assassino em até 5 s
const VANTAGEM_MIN = 2;            // vantagem numérica (vivos) a partir da qual perder o round é "desperdício"
const TICKRATE = 64;

export function lerEventos(dp, arquivo) {
  const ev = dp.parseEvents(
    arquivo,
    ['player_death', 'round_end', 'round_freeze_end', 'begin_new_match', 'bomb_planted', 'bomb_defused', 'bomb_exploded'],
    [], ['is_warmup_period']
  );
  const fe = ev.filter(e => e.event_name === 'round_freeze_end').map(e => e.tick);
  const amostra = fe.length
    ? dp.parseTicks(arquivo, ['team_num', 'name', 'steamid', 'current_equip_value'], fe)
    : [];
  const h = dp.parseHeader(arquivo);
  return { ev, amostra, mapa: h.map_name };
}

export function calcular({ ev, amostra, mapa }) {
  // descarta aquecimento e tudo antes do último "begin_new_match"
  const inicio = Math.max(0, ...ev.filter(e => e.event_name === 'begin_new_match').map(e => e.tick));
  const valido = ev.filter(e => e.tick >= inicio && !e.is_warmup_period);
  const freezes = valido.filter(e => e.event_name === 'round_freeze_end').map(e => e.tick).sort((a, b) => a - b);
  const fins = valido.filter(e => e.event_name === 'round_end').sort((a, b) => a.tick - b.tick);
  const mortes = valido.filter(e => e.event_name === 'player_death').sort((a, b) => a.tick - b.tick);
  const plant = valido.filter(e => e.event_name === 'bomb_planted').map(e => e.tick);

  // elenco por round (a partir da amostra no fim do congelamento)
  const porTick = new Map();
  for (const r of amostra) {
    if (!porTick.has(r.tick)) porTick.set(r.tick, []);
    porTick.get(r.tick).push(r);
  }
  const nomes = {};
  for (const r of amostra) if (r.steamid && r.steamid !== '0') nomes[String(r.steamid)] = r.name;

  const rounds = [];
  let grupoDe = null; // steam -> 'A' | 'B' (grupo = lado no round 1)
  for (let i = 0; i < fins.length; i++) {
    const fim = fins[i];
    const f0 = freezes.filter(t => t <= fim.tick).pop();
    if (f0 == null) continue;
    const prev = i > 0 ? fins[i - 1].tick : -1;
    if (f0 <= prev) continue;
    const elenco = (porTick.get(f0) || []).filter(p => p.team_num === 2 || p.team_num === 3);
    if (elenco.length < 2) continue;
    if (!grupoDe) {
      grupoDe = {};
      for (const p of elenco) grupoDe[String(p.steamid)] = p.team_num === 2 ? 'A' : 'B';
    }
    const lado = {}; // steam -> 2|3 neste round
    for (const p of elenco) lado[String(p.steamid)] = p.team_num;
    const ladoDoGrupo = { A: null, B: null };
    for (const p of elenco) { const g = grupoDe[String(p.steamid)]; if (g) ladoDoGrupo[g] = p.team_num; }
    const vivos = { 2: elenco.filter(p => p.team_num === 2).map(p => String(p.steamid)), 3: elenco.filter(p => p.team_num === 3).map(p => String(p.steamid)) };
    const equip = { 2: 0, 3: 0 };
    for (const p of elenco) equip[p.team_num] += p.current_equip_value || 0;
    const n2 = vivos[2].length || 1, n3 = vivos[3].length || 1;
    const pist = rounds.length === 0 || (rounds[rounds.length - 1].lados.A !== (ladoDoGrupo.A === 2 ? 'T' : 'CT'));
    const buy = (v, n) => { const m = v / n; return pist ? 'pistola' : m < 1500 ? 'eco' : m < 3500 ? 'force' : 'full'; };

    const dr = mortes.filter(m => m.tick >= f0 && m.tick <= fim.tick);
    const alive = { 2: new Set(vivos[2]), 3: new Set(vivos[3]) };
    const ladoDe = s => lado[s];
    const evs = []; // mortes processadas
    let maxLead = { 2: 0, 3: 0 };
    let clutch = null; // { steam, vs }
    const clutches = [];
    const marcaClutch = () => {
      for (const t of [2, 3]) {
        if (alive[t].size === 1) {
          const outro = t === 2 ? 3 : 2;
          if (alive[outro].size >= 2) {
            const s = [...alive[t]][0];
            if (!clutches.find(c => c.s === s)) clutches.push({ s, vs: alive[outro].size });
          }
        }
      }
    };
    marcaClutch();
    for (const m of dr) {
      const v = String(m.user_steamid), a = m.attacker_steamid ? String(m.attacker_steamid) : null;
      const vt = ladoDe(v); if (!vt) continue;
      const at = a && a !== '0' ? ladoDe(a) : null;
      const vivosAntes = { 2: alive[2].size, 3: alive[3].size };
      alive[vt].delete(v);
      const e = { t: m.tick, v, a: a && a !== '0' ? a : null, vt, at, tk: !!(at && at === vt), pre: vivosAntes, pos: { 2: alive[2].size, 3: alive[3].size } };
      evs.push(e);
      for (const t of [2, 3]) { const o = t === 2 ? 3 : 2; maxLead[t] = Math.max(maxLead[t], alive[t].size - alive[o].size); }
      marcaClutch();
    }
    // abertura: primeira morte causada pelo inimigo
    const abertura = evs.find(e => e.a && !e.tk);
    // trade: morte de V por K; um colega de V mata K em até JANELA
    const jan = JANELA_TRADE_S * TICKRATE;
    for (const e of evs) {
      e.tradavel = false; e.tradada = false;
      if (!e.a || e.tk) continue;
      // havia colega vivo logo após a morte?
      const colegasVivos = e.pos[e.vt];
      e.tradavel = colegasVivos > 0;
      const cobrada = evs.find(x => x.t > e.t && x.t <= e.t + jan && x.v === e.a && x.a && ladoDe(x.a) === e.vt);
      if (cobrada) { e.tradada = true; cobrada.eTrade = true; cobrada.paraQuem = e.v; }
    }
    const vencedorLado = fim.winner === 'T' ? 2 : fim.winner === 'CT' ? 3 : null;
    const vencedorGrupo = vencedorLado == null ? null : (ladoDoGrupo.A === vencedorLado ? 'A' : 'B');
    const perdedorLado = vencedorLado === 2 ? 3 : 2;
    const desperdicio = vencedorLado != null && maxLead[perdedorLado] >= VANTAGEM_MIN
      ? (ladoDoGrupo.A === perdedorLado ? 'A' : 'B') : null;
    rounds.push({
      n: rounds.length + 1,
      v: vencedorGrupo,
      motivo: fim.reason,
      lados: { A: ladoDoGrupo.A === 2 ? 'T' : 'CT', B: ladoDoGrupo.B === 2 ? 'T' : 'CT' },
      pistola: rounds.length===0 || (rounds[rounds.length-1].lados.A !== (ladoDoGrupo.A === 2 ? 'T' : 'CT')),
      compra: { A: buy(equip[ladoDoGrupo.A], ladoDoGrupo.A === 2 ? n2 : n3), B: buy(equip[ladoDoGrupo.B], ladoDoGrupo.B === 2 ? n2 : n3) },
      plantou: plant.some(t => t >= f0 && t <= fim.tick),
      abertura: abertura ? { k: abertura.a, v: abertura.v, g: grupoDe[abertura.a] } : null,
      desperdicio,
      clutches: clutches.map(c => ({ s: c.s, vs: c.vs, ganhou: ladoDe(c.s) === vencedorLado })),
      mortes: evs
    });
  }
  if (!rounds.length) return null;

  // agregação por jogador e por grupo
  const jog = {};
  const J = s => (jog[s] ||= {
    steam64: s, nome: nomes[s] || s, g: grupoDe[s],
    abates: 0, mortes: 0, aberturas_ganhas: 0, aberturas_perdidas: 0,
    mortes_tradaveis: 0, mortes_trocadas: 0, mortes_sem_trade: 0, trades_feitos: 0,
    clutches: 0, clutches_ganhos: 0, rounds: 0
  });
  for (const s of Object.keys(grupoDe)) J(s);
  for (const r of rounds) {
    for (const s of Object.keys(grupoDe)) J(s).rounds++;
    if (r.abertura) {
      J(r.abertura.k).aberturas_ganhas++; J(r.abertura.v).aberturas_perdidas++;
    }
    for (const e of r.mortes) {
      J(e.v).mortes++;
      if (e.a && !e.tk) J(e.a).abates++;
      if (e.tradavel) {
        J(e.v).mortes_tradaveis++;
        if (e.tradada) J(e.v).mortes_trocadas++; else J(e.v).mortes_sem_trade++;
      }
      if (e.eTrade) J(e.a).trades_feitos++;
    }
    for (const c of r.clutches) { J(c.s).clutches++; if (c.ganhou) J(c.s).clutches_ganhos++; }
  }

  const grupos = { A: [], B: [] };
  for (const [s, g] of Object.entries(grupoDe)) grupos[g].push(s);
  const placar = { A: rounds.filter(r => r.v === 'A').length, B: rounds.filter(r => r.v === 'B').length };

  // totais coletivos por grupo
  const coletivo = {};
  for (const g of ['A', 'B']) {
    const rs = rounds;
    const meus = grupos[g].map(s => jog[s]);
    const soma = k => meus.reduce((t, p) => t + p[k], 0);
    const abOk = rs.filter(r => r.abertura && r.abertura.g === g).length;
    const abNeg = rs.filter(r => r.abertura && r.abertura.g !== g).length;
    const comAb = rs.filter(r => r.abertura);
    const venceuAbPos = rs.filter(r => r.abertura && r.abertura.g === g && r.v === g).length;
    const venceuAbNeg = rs.filter(r => r.abertura && r.abertura.g !== g && r.v === g).length;
    coletivo[g] = {
      rounds_ganhos: placar[g],
      aberturas_positivas: abOk, aberturas_negativas: abNeg,
      venceu_apos_abertura_positiva: venceuAbPos, venceu_apos_abertura_negativa: venceuAbNeg,
      mortes_tradaveis: soma('mortes_tradaveis'), mortes_sem_trade: soma('mortes_sem_trade'), mortes_trocadas: soma('mortes_trocadas'),
      vantagens_desperdicadas: rs.filter(r => r.desperdicio === g).length,
      vantagens_convertidas: rs.filter(r => r.v === g).length, // contexto
      clutches: soma('clutches'), clutches_ganhos: soma('clutches_ganhos')
    };
  }
  return { mapa, rounds_total: rounds.length, placar, grupos, jogadores: Object.values(jog), coletivo, rounds };
}

// Versão enxuta para guardar no banco: mortes como [seg, assassino, vítima, flags]
// flags: 1 = fogo amigo, 2 = tradável, 4 = trocada, 8 = foi uma troca (trade feito)
export function compactar(r) {
  const idx = {}; const ids = r.jogadores.map(p => p.steam64);
  ids.forEach((s, i) => idx[s] = i);
  return {
    v: 1, mapa: r.mapa, n: r.rounds_total, placar: r.placar, grupos: r.grupos,
    jogadores: r.jogadores, coletivo: r.coletivo,
    rounds: r.rounds.map(x => ({
      n: x.n, v: x.v, m: x.motivo, l: x.lados, c: x.compra, pi: x.pistola ? 1 : 0, pl: x.plantou ? 1 : 0,
      ab: x.abertura ? [idx[x.abertura.k], idx[x.abertura.v]] : null, dp: x.desperdicio,
      cl: x.clutches.map(c => [idx[c.s], c.vs, c.ganhou ? 1 : 0]),
      mt: x.mortes.map(e => [idx[e.a] ?? -1, idx[e.v], (e.tk ? 1 : 0) | (e.tradavel ? 2 : 0) | (e.tradada ? 4 : 0) | (e.eTrade ? 8 : 0)])
    }))
  };
}

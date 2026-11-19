// Leitor reserva: abre a demo com o cs2parser (que acompanha as atualizações novas do CS2)
// e entrega os eventos no MESMO formato do demoparser2. Assim o resto do robô (estatísticas,
// placar, KAST e a análise de rounds) não muda nada.
const EVENTOS = ['player_death', 'player_hurt', 'player_blind', 'round_end', 'round_freeze_end', 'begin_new_match',
  'bomb_planted', 'bomb_defused', 'bomb_exploded', 'flashbang_detonate', 'smokegrenade_detonate', 'weapon_fire'];
const GRANADA = /grenade|flashbang|molotov|incendiary|decoy/i;
// motivo do fim da rodada, nos nomes que o demoparser2 usava
const MOTIVO = { 1: 'bomb_exploded', 7: 'bomb_defused', 8: 't_killed', 9: 'ct_killed', 10: 'draw', 12: 'target_saved', 17: 't_surrender', 18: 'ct_surrender' };

export async function lerComCs2(arquivo, mod) {
  const { DemoReader, EntityMode } = mod || (await import('cs2parser'));
  const rd = new DemoReader();
  const ev = [];
  const fotos = []; // quem estava em cada time no fim do congelamento e no fim de cada rodada
  const regras = () => rd.gameRules || null;
  const jogador = (row, pref, p) => {
    if (!p) { row[pref + '_steamid'] = null; return; }
    row[pref + '_steamid'] = String(p.steamId || '');
    row[pref + '_name'] = p.name;
    row[pref + '_team_num'] = p.teamNumber;
  };
  const equipamento = (p) => {
    try {
      const id = p.pawnEntityId;
      if (id != null) {
        const e = rd.getEntity(id, 'CCSPlayerPawn');
        const v = e && (e['CCSPlayerPawn.m_unCurrentEquipmentValue'] ?? e.m_unCurrentEquipmentValue);
        if (typeof v === 'number') return v;
      }
    } catch { /* sem o valor do equipamento */ }
    return p.round_equipmentValue || 0;
  };
  // rating Premier do controlador (antes da partida e o previsto para vitória/derrota/empate), nos nomes do demoparser2
  const rating = (p) => {
    try {
      let e = null;
      try { e = rd.getEntity(p.entityId, 'CCSPlayerController'); } catch { /* segue */ }
      e = e || (p.entity && p.entity.properties) || null;
      if (!e) { diag.rkChaves = diag.rkChaves || 'sem entidade'; return {}; }
      if (!diag.rkChaves) { // só nomes de campos, nunca valores
        const todas = e instanceof Map ? [...e.keys()].map(String) : Object.keys(e);
        const ks = todas.filter((k) => /ompetitive|Rank/i.test(k));
        diag.rkChaves = ks.length ? ks.map((k) => k.replace(/^CCSPlayerController\./, '')).join(',').slice(0, 300) : 'nenhum campo de rank (' + todas.length + ' campos)';
      }
      const g = (k) => { let v = e['CCSPlayerController.' + k] ?? e[k]; if (v == null && typeof e.get === 'function') v = e.get('CCSPlayerController.' + k) ?? e.get(k); return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null; };
      return { rank: g('m_iCompetitiveRanking'), rank_if_win: g('m_iCompetitiveRankingPredicted_Win'), rank_if_loss: g('m_iCompetitiveRankingPredicted_Loss'),
        rank_if_tie: g('m_iCompetitiveRankingPredicted_Tie'), comp_rank_type: g('m_iCompetitiveRankType') };
    } catch { return {}; }
  };
  const fotografar = (tick) => {
    for (const p of rd.playerControllers) {
      const id = String(p.steamId || '');
      if (!/^\d{17}$/.test(id)) continue;
      fotos.push({ tick, steamid: id, name: p.name, team_num: p.teamNumber, current_equip_value: equipamento(p), ...rating(p) });
    }
  };
  // última foto do inventário de cada jogador (o cs2parser avisa quando o inventário muda)
  const invs = new Map();
  const diag = { fotos: 0, fotosComGranada: 0, mortesSemFoto: 0, mortesMesmoTick: 0, pegou: 0, lancou: 0, morte3Foto: 0, morte3Conta: 0, fonte: 'foto' }; // só contagens, para a conferência
  // Plano B, quando a demo não traz as fotos do inventário: contamos nós mesmos as granadas de cada jogador.
  // +1 a cada granada comprada ou pega do chão, -1 a cada granada lançada; zera quando morre e na troca de lado.
  const conta = new Map();
  const ehGranada = (w) => GRANADA.test(String(w || '')) || /hegrenade|smokegrenade|incgrenade|molotov|decoy|flashbang/i.test(String(w || ''));
  rd.gameEvents.on('item_pickup', (e) => {
    try {
      const id = String((e && e.player && e.player.steamId) || '');
      if (!/^\d{17}$/.test(id) || !ehGranada(e.item)) return;
      const g = regras(); if (g && g.isWarmup) return;
      conta.set(id, Math.min((conta.get(id) || 0) + 1, 4)); diag.pegou++;
    } catch { /* ignora */ }
  });
  const contarGranadas = (inv) => (inv && Array.isArray(inv.items) ? inv.items : []).filter((it) => GRANADA.test(String(it.className || it.name))).reduce((t, it) => t + (Number(it.quantity) || 1), 0);
  rd.gameEvents.on('inventory_snapshot', (e) => {
    try {
      const id = String((e && e.player && e.player.steamId) || '');
      if (!/^\d{17}$/.test(id)) return;
      const tick = rd.currentTick, g = contarGranadas(e.inventory), ant = invs.get(id);
      diag.fotos++; if (g > 0) diag.fotosComGranada++;
      // "antes" guarda a foto anterior, para o caso de a foto vazia da morte chegar no mesmo tick
      invs.set(id, { tick, g, antes: ant ? (ant.tick < tick ? ant.g : ant.antes) : 0 });
    } catch { /* sem a foto */ }
  });
  // posição de cada boneco nos últimos ticks, para medir a velocidade na hora do tiro (contra-strafe)
  const trilha = new Map(); // steam64 -> [{t, x, y}] (só os últimos 24 ticks)
  rd.on('tickend', (t) => {
    try {
      for (const p of rd.playerControllers) {
        const id = String(p.steamId || ''); if (!/^\d{17}$/.test(id)) continue;
        const q = p.position; if (!q || typeof q.x !== 'number') continue;
        const L = trilha.get(id) || trilha.set(id, []).get(id);
        L.push({ t, x: q.x, y: q.y }); if (L.length > 24) L.shift();
      }
    } catch { /* sem a posição */ }
  });
  const velocidade = (L, t) => { // unidades por segundo no tick t (de t-1 para t)
    const a = L.find((z) => z.t === t), b = L.find((z) => z.t === t - 1);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) * 64 : null;
  };
  for (const nome of EVENTOS) {
    rd.gameEvents.on(nome, (e) => {
      const g = regras();
      const tick = rd.currentTick;
      const row = { event_name: nome, tick, total_rounds_played: g ? g.roundsPlayed : 0, is_warmup_period: !!(g && g.isWarmup) };
      for (const [k, v] of Object.entries(e || {})) if (v == null || typeof v !== 'object') row[k] = v;
      jogador(row, 'user', e && e.player);
      if (e && 'attacker' in e) jogador(row, 'attacker', e.attackerPlayer);
      if (e && 'assister' in e) jogador(row, 'assister', e.assisterPlayer);
      if (row.is_warmup_period && nome !== 'begin_new_match') return; // aquecimento não conta
      if (nome === 'begin_new_match') conta.clear();
      if (nome === 'weapon_fire' && !ehGranada(e && e.weapon)) {
        try {
          const id = String((e && e.player && e.player.steamId) || '');
          const L = (trilha.get(id) || []).slice();
          const q = e.player && e.player.position;
          if (q && typeof q.x === 'number' && !L.some((z) => z.t === tick)) L.push({ t: tick, x: q.x, y: q.y });
          row._v0 = velocidade(L, tick); row._v1 = velocidade(L, tick - 16);
        } catch { /* sem a velocidade */ }
      }
      if (nome === 'weapon_fire' && ehGranada(e && e.weapon)) {
        const id = String((e && e.player && e.player.steamId) || '');
        if (conta.get(id)) { conta.set(id, conta.get(id) - 1); diag.lancou++; }
      }
      if (nome === 'player_death') {
        // granadas que a vítima tinha na mão quando morreu (para o "comprou à toa").
        // Na hora da morte o inventário já vem vazio; por isso usamos a última foto do inventário ANTES dessa morte.
        const id = String((e && e.player && e.player.steamId) || '');
        const f = invs.get(id);
        row._conta = conta.get(id) || 0; conta.set(id, 0);
        if (!f) diag.mortesSemFoto++;
        else if (f.tick === tick) diag.mortesMesmoTick++;
        if (f) row.granadas = f.tick < tick || f.g > 0 ? f.g : f.antes;
      }
      if (nome === 'round_end') {
        if (e.winner !== 2 && e.winner !== 3) return; // "a partida vai começar" e afins não são rodadas
        row.winner = e.winner === 2 ? 'T' : 'CT';
        row.reason = MOTIVO[e.reason] || String(e.reason);
        if (g && g.roundsPlayed === 12) conta.clear(); // troca de lado no meio do jogo: inventário zera
        fotografar(tick);
      }
      if (nome === 'round_freeze_end') fotografar(tick);
      ev.push(row);
    });
  }
  const r = await rd.parseDemo(arquivo, { entities: EntityMode.ALL });
  // escolhe a fonte das granadas na hora da morte: foto do inventário quando a demo traz, senão a nossa contagem
  const mortesEv = ev.filter((x) => x.event_name === 'player_death');
  for (const x of mortesEv) { if ((x.granadas || 0) >= 3) diag.morte3Foto++; if ((x._conta || 0) >= 3) diag.morte3Conta++; }
  // As fotos do inventário do cs2parser vêm só no começo da partida (cerca de 10 por demo) e repetem números velhos;
  // na conferência de 14/11 a nossa contagem deu uma distribuição igual à do leitor principal. Por isso vale sempre a contagem.
  diag.fonte = 'contagem';
  for (const x of mortesEv) x.granadas = x._conta || 0;
  for (const x of mortesEv) delete x._conta;
  if (!ev.some((x) => x.event_name === 'round_end')) throw new Error(`cs2parser não achou rodadas (${r && r.status})`);
  let cab = null;
  try { cab = DemoReader.parseHeader(arquivo); } catch { /* sem cabeçalho */ }
  const copia = (x) => ({ ...x });
  return {
    leitor: 'cs2parser',
    diag,
    parseEvent: (_a, nome) => ev.filter((x) => x.event_name === nome).map(copia),
    parseEvents: (_a, nomes) => { const s = new Set(nomes); return ev.filter((x) => s.has(x.event_name)).map(copia); },
    parseTicks: (_a, _props, ticks) => { const s = new Set(ticks); return fotos.filter((x) => s.has(x.tick)).map(copia); },
    parseHeader: () => ({ ...(cab || {}), map_name: (cab && (cab.map_name || cab.mapName)) || null }),
  };
}

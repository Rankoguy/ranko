// Abre uma demo com UM leitor e imprime uma linha: "ABRIU ..." ou "FALHOU ...". Roda em processo separado
// porque o leitor em Rust pode derrubar o processo inteiro quando não entende a demo.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [, , quem, arq] = process.argv;
const resumo = (e) => String((e && e.message) || e).replace(/https?:\/\/\S+/g, '[endereço]').replace(/\d{9,}/g, '#').replace(/\s+/g, ' ').slice(0, 90);
try {
  if (quem.startsWith('go-')) {
    const { spawnSync } = await import('node:child_process');
    const bin = new URL('./leitor-go/' + quem, import.meta.url).pathname;
    const r = spawnSync(bin, [arq], { encoding: 'utf8', timeout: 290000 });
    const linha = String(r.stdout || '').trim().split('\n').pop();
    console.log(linha || `FALHOU (o leitor Go travou${r.error ? ': ' + String(r.error.message).slice(0, 40) : ''})`);
  } else if (quem === 'cs2parser') {
    const { DemoReader, EntityMode } = await import('cs2parser');
    const p = new DemoReader();
    let rodadas = 0, mortes = 0;
    p.gameEvents.on('round_end', () => { rodadas++; });
    p.gameEvents.on('player_death', () => { mortes++; });
    await p.parseDemo(arq, { entities: EntityMode.ONLY_GAME_RULES });
    console.log(rodadas ? `ABRIU (rodadas ${rodadas}, mortes ${mortes})` : 'FALHOU (leu o arquivo mas não achou nenhuma rodada)');
  } else {
    const lib = require(quem === 'atual' ? '@laihoe/demoparser2' : quem);
    const rodadas = lib.parseEvent(arq, 'round_end').length;
    const mortes = lib.parseEvent(arq, 'player_death').length;
    console.log(rodadas ? `ABRIU (rodadas ${rodadas}, mortes ${mortes})` : 'FALHOU (leu o arquivo mas não achou nenhuma rodada)');
  }
} catch (e) { console.log(`FALHOU (${resumo(e)})`); }

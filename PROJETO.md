# Ranko — documento do projeto

> Leia este arquivo primeiro. Ele resume o que é o projeto, o que já foi decidido (e por quê), como tudo funciona por dentro, o que está pronto, o que falta e para onde vamos.
> Última atualização: 10/11/2026. Dono: Juan (designer freelancer, fala português, ~4 h por semana para o projeto).

---

## 0. Como trabalhamos (leia antes de começar)

O projeto evolui em três **faixas de trabalho**. Em cada sessão, o Juan diz em qual faixa quer trabalhar, e a conversa fica nela. Quando uma mudança toca em mais de uma faixa, ela é separada em entregas (primeiro a correção, depois a funcionalidade, depois o visual) ou a mistura é declarada antes de começar.

| Faixa | O que é | Cuidados desta faixa |
|---|---|---|
| **Visual** | Aparência, sem mudar o que o site faz | Mexe só em CSS e textos. Não toca em login, Worker nem robô. Conferir contraste nos dois temas e no celular. Entrega: só o `index.html`. |
| **Funcionalidades** | Coisas novas | O Juan decide o escopo antes de construir. O que depende de terceiros (Valve, Steam) é **testado antes** de construir em cima. Entrega: arquivos novos com a ordem de publicação. |
| **Perfil** (desde 12/11) | Tudo o que o jogador vê sobre ele mesmo: histórico de partidas, tela da partida, análise individual | Mexe em robô, Worker e site juntos; a entrega traz a ordem de publicação. Regra do Juan: o projeto **não pode guardar nem mostrar só quem está no painel**; os números de quem está fora também são guardados (sem o id da Steam). |
| **Correções** | Algo quebrado ou errado | Primeiro entender a causa (log, print, F12), depois a menor mudança possível. Não aproveitar para mexer em visual ou funções. Fecha quando o Juan confirmar que o problema sumiu. |

**Regras que valem para as três**
1. **A fonte da verdade é o que está publicado** (repositório `rankoguy/ranko` e Cloudflare). Antes de mexer, o Claude parte do arquivo atual que o Juan enviar, nunca de uma cópia antiga. Se houve outra conversa trabalhando no mesmo arquivo, o Juan envia a versão atual.
2. **Uma entrega, uma faixa**, sempre com a ordem de publicação escrita (por exemplo: banco, Worker, robô, site) e um jeito de conferir que funcionou.
3. **No fim de cada sessão, atualizar a seção 7** (estado atual): o que mudou, o que está no ar e o que ficou pendente. Se o trabalho foi feito em outra conversa, o Juan cola o resumo lá.
4. **O que não foi testado fica marcado como "não verificado"** e só vira fato depois do teste.
5. **Backup antes de substituir**: copiar o código atual do Cloudflare para um bloco de notas antes de colar o novo.
6. **Segredos nunca vão para o chat nem para o repositório**: senhas, token de renovação da conta Ranko, chaves da API.

**Ordem definida pelo Juan em 10/11/2026:** primeiro terminar os testes do rating Premier, depois a faixa **Visual**, depois **Funcionalidades**, depois **Correções**. O quadro de pendências de cada faixa está na seção 7.

---

## 1. O que é o Ranko

Um painel de desempenho de **CS2** para **times de amigos**, gratuito, no estilo do Leetify. Cada time ("time", nunca "clã" na tela) tem:

- Perfil de cada jogador (rating, aberturas, utilidade, posição, conquistas, pontos fortes e fracos).
- Ranking do time (semana, mês e geral).
- **Trollagem** (brincadeira: quem atrapalhou mais, fogo amigo, granada em amigo etc.).
- **Mapas e funções**: quais mapas picar/evitar e quem joga o quê.
- **Partidas do time**: partidas em que 4 ou mais do time jogaram juntos.
- Convite por link, troca de cores do tema, modo claro e escuro.

O visual e o código foram refeitos várias vezes. A versão oficial é o `index.html` entregue por último (arquivo único).

**Endereços**
- Site: `https://rankoguy.github.io/ranko/` (GitHub Pages, repositório público `rankoguy/ranko`).
- Worker (API e login): `https://painel-login.rankoguy.workers.dev` (Cloudflare).
- O subdomínio `rankoguy.workers.dev` foi escolhido para não aparecer o nome pessoal do Juan na tela de login da Steam.

---

## 2. Regras que não mudam (restrições do Juan)

| Regra | Por quê |
|---|---|
| **Custo zero** (hospedagem, banco, robô) | Projeto de amigos; nada de assinatura de servidor. Só o futuro pagamento terá taxa por venda. |
| **Português do Brasil**, tom simples | O público é brasileiro. |
| **"Time", não "clã"** | Decisão de linguagem do Juan. |
| **Passo a passo de deploy explicado no chat** | O Juan faz a publicação; prefere ver os passos na conversa, não só em arquivo. |
| **Não usar amigos reais em material de divulgação** | Privacidade. Os testes e vídeos usam jogadores fictícios (Kaito, Mimi, Zeca, Nina, Tobias; time "Time Demo"). |
| **Não revogar acesso nem resetar nada ao mudar o formulário de ligar** | Os amigos já tinham ligado a leitura; mudar a tela não pode quebrar quem já está funcionando. |
| **Nada de leitura de posição por tick** (Awpy e Intelligence ficam **pausados**) | Pesado, caro e fora do escopo. Só eventos (mortes, rounds, bomba). |

---

## 3. Arquitetura (3 peças)

```
 Amigos ──► SITE (index.html, GitHub Pages) ──► WORKER (Cloudflare) ──► BANCO D1
                                                      ▲
            ROBÔ (GitHub Actions, a cada ~2 h) ───────┘  (envia só resumos)
              │ usa o código de autenticação + código da partida de cada pessoa
              └► Steam (Game Coordinator) ► baixa a demo ► lê ► apaga a demo
```

### 3.1 Site — `index.html`
- Uma página só, sem framework. Rotas por `#/` (por exemplo `#/cla/<slug>`, `#/jogador/<steam64>`).
- Tema: variáveis CSS em `:root`; modo claro em `:root[data-modo="claro"]`. Preferências no `localStorage` (`painel_modo`, `painel_fonte`, `painel_modo_time`, `painel_token`).
- **Cor da fonte controlável** (auto, escura, clara ou livre) com leitura de contraste.
- Barra lateral com degradê da cor principal até o fundo escuro.
- Há um modo **Simples | Pro** na barra do time (ver seção 6).
- A URL do Worker está fixa no código (`WORKER`) e no `connect-src` do CSP.

### 3.2 Worker — `worker.js` (Cloudflare Workers + D1)
- Login pela Steam (OpenID). Sessão assinada.
- Rotas públicas de leitura (perfil, time, partidas do time) com **cache de 20 s**.
- **Proteção**: limite por IP na memória (leitura 120/min, escrita 30/min; variáveis `LIMITE_LEITURA` e `LIMITE_ESCRITA`), resposta 429. As rotas `/interno` e `OPTIONS` não entram no limite.
- Rotas do robô em `/interno/*`, protegidas pelo cabeçalho `x-robo` (segredo `ROBO_SECRET`).
- **Rota nova do Analyst**: `GET /api/cla/<slug>/analise` (só logado, só do time, só se o time for Pro).
- **Perfil (12/11):** `GET /api/jogador/<id>/partidas` (histórico: até 100 partidas, com placar e Rank do dia), `GET /api/partida/<id>` (os 10 jogadores; público e com cache) e `GET /api/partida/<id>/analise` (logado, só de quem jogou a partida, só com o plano individual; devolve a análise só dele).
- Limites do plano grátis do Cloudflare: 100 mil pedidos por dia e 10 ms de CPU por pedido.

### 3.3 Banco D1 — tabelas (arquivo `schema.sql`)
| Tabela | Para quê |
|---|---|
| `clas` | Os times (id, nome, slug, dono, convite, imagem). |
| `jogadores` | Quem está no painel (steam64, nome, avatar, time, dados em cache). |
| `fontes` | Quem ligou a leitura de demos (código de autenticação, último código lido). |
| `partidas_jog` | Estatísticas por jogador e por partida (`partida` é o id da partida e é o mesmo para todos que jogaram). Guarda 90 dias. |
| `resumo_mensal` | Partidas com mais de 90 dias viram totais do mês (o desempenho fica para sempre). |
| `funcoes` | Função autodeclarada (TR, posição de CT por mapa, mapas de conforto e a evitar). |
| `analise_partida` | **Novo.** Resumo de rounds de cada partida analisada (cerca de 8 KB). Guarda 60 dias. |
| `planos` | **Novo.** Quais times são Pro e até quando (`cla_id`, `ate`, `origem`). |
| `plano_individual` | Respostas do formulário do plano individual (pretensão, meta, tempo, equilíbrio, hábitos, rating digitado). |
| `rating_hist` | Rating Premier por pessoa, um por dia (`steam64`, `dia`, `rating`). Guarda 400 dias. |
| `planos_ind` | Quem tem o plano individual liberado e até quando (`steam64`, `ate`, `origem`). |
| `partida_info` | **Novo (12/11).** Uma linha por partida lida: mapa, rounds e placar dos dois times. Guarda 90 dias. Arquivo `schema-partidas.sql`. |
| `partida_jog_todos` | **Novo (12/11).** Os 10 jogadores de cada partida (abates, assistências, mortes, dano, HS, rounds com KAST, 2K a 5K, time 0/1). `steam64` só existe para quem está no painel; quem está fora fica **só com o apelido de jogo** (decisão de privacidade: não dá para achar o perfil dessa pessoa). Guarda 90 dias. |

### 3.4 Robô — `demos/ler-demos.mjs` (+ `demos/analise.mjs`) e workflow `ler-demos.yml`
- Roda no GitHub Actions (repositório público = minutos grátis).
- Para cada pessoa que ligou a leitura: pede a demo pelo Game Coordinator (`steam-user` + `globaloffensive`), baixa, descompacta (`bunzip2`), lê com `@laihoe/demoparser2` (ou, se ele falhar, com o leitor reserva `cs2parser`, ver abaixo) e **envia só números** ao Worker. Nunca imprime apelidos nem códigos.
- Segurança do download: só aceita endereços da Valve/Steam (`valve.net`, `steamcontent.com`, `steamserver.net`, `steamcdn-a.akamaihd.net`) e recusa arquivo acima de 600 MB.
- Até 10 partidas novas por pessoa a cada execução (`MAX_POR_PESSOA`) e para antes de estourar o tempo (`LIMITE_MINUTOS`).
- **Rating Premier:** o robô pede o perfil de cada pessoa ao servidor do CS2 (`requestPlayersProfile`) e lê o rating na entrada de ranking de tipo 11. **Só funciona para quem é amigo da conta Ranko** (a Valve ignora o pedido para quem não é). Pessoas que ainda não são amigas são puladas. O teste de 10/11 leu o rating real da conta pessoal do Juan, que é amiga da conta Ranko. Nunca imprime o valor no log, porque o log do GitHub é público. Para diagnóstico, rodar o workflow com `depurar_rating = sim`.
- **Frequência (11/11):** roda a cada 30 minutos (`7,37 * * * *`) e também sob demanda: o Worker chama o GitHub (`workflow_dispatch`) quando alguém liga a leitura ou clica em **Atualizar agora** (limite: 1 chamada a cada 5 min para todos e 1 a cada 10 min por pessoa, tabela `robo_disparo`). Cada rodada faz login na Steam; se a Steam reclamar, voltar o horário para 1 hora.
- **Amizade com a conta Ranko (11/11):** a cada rodada o robô aceita convites de quem já entrou no painel (`/interno/conhecidos`) e envia convites (máx. 5 por rodada) a quem ligou a leitura e ainda não é amigo; grava o estado (`amigo`, `convidado`, `nenhum`) na tabela `amizade_robo` (`/interno/amizades`). O site mostra aviso com o link de amizade para quem ainda não é amigo. Variáveis do Worker usadas: `GH_TOKEN` (Secret; token fine-grained só do repositório `rankoguy/ranko` com **Actions: Read and write**; vence em até 1 ano), `GH_REPO` (`rankoguy/ranko`), `LINK_AMIZADE` (link de amizade da conta Ranko) e, só se o ramo não for `main`, `GH_REF`.
- **Quadro completo (12/11):** de cada demo o robô tira também os 10 jogadores (nome, time, abates, assistências, mortes, dano, HS, KAST, multi-abates) e o placar, e manda no campo novo `completas` (o campo `partidas` não mudou). Time 0 = quem começou de T. KAST = rounds com abate, assistência, sobrevivência ou morte trocada em até 5 s. Se essa parte falhar, a partida continua entrando só com os números do painel. Partidas lidas **antes** dessa versão não têm placar nem quadro (aparecem no histórico só com os números do jogador). Com `DEPURAR_RATING=sim`, o log mostra os **nomes dos campos** (nunca valores) que a Valve manda na partida, para descobrirmos se há modo (Premier/Competitivo) e rank por partida.
- **Leitor reserva (12/11):** a atualização do CS2 (patch 14197) fez o `demoparser2` falhar em todas as demos (`EntityNotFound`), inclusive versões antigas. O robô agora tenta o `demoparser2` e, se falhar, abre a demo com o `cs2parser` (`demos/leitor-cs2.mjs`), que entrega os eventos no mesmo formato; o cálculo não muda. Validado em 12/11 com 4 demos reais (rodadas = placar, abates de um time = mortes do outro). O leitor Go (`demoinfocs-golang`) foi testado e descartado por ora. Aquecimento é ignorado.
- **Modo de conferência:** **Run workflow** com `conferir = sim` lê até 4 partidas e mostra no log só data, mapa, placar e totais por time, sem gravar nada e sem andar a fila.
- **Log público:** tudo que sai no log passa por um filtro que tira endereços, ids da Steam e códigos (`limpar`).
- **Bibliotecas travadas (13/11):** versões exatas no `package.json` + `package-lock.json` (lista fechada com conferência de integridade); o workflow instala com `npm ci --ignore-scripts`. As actions do GitHub estão travadas por código (SHA) e sem credencial do repositório. **Atualizar uma biblioteca é decisão do Juan:** antes, dizer quem publicou, o que muda e a que segredos ela tem acesso, e gerar uma lista nova. Sem o `package-lock.json` em `demos`, o robô para (é a trava funcionando).
- Segredos no GitHub: `WORKER_URL` (**deve ser** `https://painel-login.rankoguy.workers.dev`), `STEAM_API_KEY`, `STEAM_REFRESH_TOKEN`, `ROBO_SECRET`.

---

## 4. Como o jogador liga a leitura das próprias partidas

O formulário "Ligar" tem **dois campos**, nesta ordem:
1. **Código de autenticação** (formato `XXXX-XXXXX-XXXX`).
2. **Código da partida mais recente** (começa com `CSGO-`).

**Por que dois campos e não colar a página inteira da Steam:** os amigos acharam o fluxo de colar a página confuso. Dois códigos curtos são mais simples. Não foi preciso mudar o Worker nem revogar nada.

O robô só lê demos de partidas **do próprio jogador**, com os códigos que ele mesmo fornece.

---

## 5. Decisões tomadas e os motivos

### Produto e design
- **Base oficial = `index.html` do Juan** (depois de ele passar uma skill de design). Passou a ser o único arquivo a editar, em vez de reconstruir.
- **Partida do time = 4 ou mais do time na mesma partida** (em times com menos de 4 membros, todos). Partida solo aparece só no perfil.
- **Fotos no lugar de apelidos em "Mapas e funções"**: mais rápido de ler; o nome aparece ao passar o mouse.
- **"Pontos fracos e trollagem"** no perfil: a Trollagem saiu de um bloco próprio e virou parte dos pontos fracos (com etiqueta), para o perfil ficar mais limpo.
- **Função salva** mostra um resumo com botão "Editar", em vez de deixar o formulário aberto o tempo todo.
- **Setas dos selects** afastadas da borda (aparência e legibilidade).
- **Contraste**: verificado nos dois temas com varredura automática (WCAG). Os números decorativos do pódio (`.base`) são ignorados de propósito.
- **Conquistas**: o Juan ainda está pensando num redesenho.

### Segurança e custo
- **Proteção contra abuso**: limite por IP + cache de 20 s. Não é um escudo global (cada servidor conta por conta própria), mas barra abuso simples e poupa o banco.
- **Repositório público**: o GitHub Pages grátis exige público, e o robô grátis também. Tornar privado exigiria plano pago, então foi descartado. Fork não dá para bloquear em repositório público, mas **não afeta o site**, e os segredos não são copiados.
- **Quem pode dar commit**: só dono e colaboradores. Foi recomendado travar a branch principal (bloquear exclusão e force push), proteger as Actions contra PRs de estranhos e ligar a verificação em duas etapas na conta.
- **Revisão de segurança (12–13/11):** nenhuma rota pública devolve códigos da Steam nem o convite do time (só o dono recebe); login confirmado com a Steam e sessão assinada; `/interno` exige a senha do robô; nomes vindos de demos são escapados (inclusive apóstrofo) e a CSP só permite falar com o Worker. "Desligar e apagar" também tira a pessoa das telas de partida (vira "Jogador"). **Riscos aceitos/abertos:** perfis e times são públicos para quem tem o link; sessão vale 30 dias sem revogação individual (trocar `SESSION_SECRET` derruba todas); análises antigas guardam o id do membro até expirar (60 dias); conta-robô pode sofrer restrição da Valve; conferir backup do D1; política de privacidade e termos antes de abrir ao público ou cobrar.
- **Privacidade da análise**: o banco **não guarda apelidos** e só guarda o Steam ID de quem já está no painel; adversários viram `x0..x9`. Na resposta, quem não é do time **nunca** aparece identificado.

### Monetização (Team Pro)
- **Quem paga: o time** (provavelmente o dono). Ainda não decidido de forma definitiva.
- **Modo Simples (grátis) e modo Pro (pago)**. O Pro **não substitui** o Simples: só acrescenta o Analyst e o Coach.
- **No modo Pro saem da tela** Conquistas, Ranking da trollagem e o card "Maior troll", porque são brincadeira e não ajudam na análise do time. Ao voltar para o Simples, tudo reaparece.
- **Botão "Pro" brilhante** (animação de brilho e halo) para chamar atenção. Respeita "reduzir movimento".
- **Bloqueio no servidor**: sem plano Pro, o Worker não devolve nenhum dado de análise. Esconder só na tela não protegeria.
- **Zero IA e zero custo por uso**: toda a análise é feita por contagem e regras escritas à mão.

### Análise
- **Só eventos, nada de posição por tick** (Awpy e Intelligence pausados, por custo, peso e foco).
- **Uma análise por partida, não por jogador**: uma demo traz os 10 jogadores; o Worker escolhe o lado "nosso" pelo grupo que tem mais gente do time.
- **O panorama é só a soma das análises de cada partida**, para os dois lugares nunca se contradizerem.

---

## 6. Time Pro: o que existe e o que falta

### 6.1 Ranko Analyst — **PRONTO** (precisa publicar e validar com partidas reais)
**O que ele calcula por partida (`demos/analise.mjs`):**
- Vencedor de cada round, lado (TR ou CT) e tipo de compra (pistola, eco, force, full).
- **Abertura**: quem ganhou ou perdeu o primeiro duelo do round.
- **Trade**: uma morte é "trocada" se um colega mata o assassino em até **5 segundos**. Só conta como "trocável" se havia colega vivo.
- **Vantagem desperdiçada**: round perdido depois de o time ter **2 ou mais vivos a mais** que o adversário.
- **Clutches** (1 contra vários) e se foram vencidos.

**Telas:**
- **Time Pro → Panorama do time**: 4 números, principais erros coletivos em ordem de gravidade e diagnóstico de cada jogador.
- **Partidas → "Ver análise"** em cada partida: por que ganhou ou perdeu (até 4 linhas), linha do tempo com um quadradinho por round, erros da partida e tabela por jogador.
- Sem plano Pro: o botão fica travado e convida ao Pro.

**Regras dos diagnósticos (valores meus, para calibrar depois de 20 a 30 partidas reais):**
- Falta de trade: aparece quando há 6 ou mais mortes trocáveis; peso cresce a partir de 50% sem troca.
- Abertura negativa: a partir de 6 duelos; peso cresce a partir de 40%.
- Vantagem desperdiçada: qualquer ocorrência.
- Diagnóstico individual: frases por limiar (por exemplo, perde 65% ou mais dos primeiros duelos; 80% ou mais das mortes sem trade).

**Testado com 2 demos reais** (nuke, 13 a 6; cache, 10 a 13). Cada demo leva uns 2 s; o resumo tem 8 KB.

### 6.2 Ranko Coach — **NÃO FEITO** (próximo)
Usa os mesmos dados do Analyst para dizer **o que fazer**. Plano:
- Biblioteca de **15 a 20 recomendações escritas à mão** (regra, texto e exercício).
- **Os 3 maiores problemas** do time (regras ordenadas por impacto).
- **Comparação entre partidas** (melhorou ou piorou) e **erros que se repetem** (contagem nas últimas N partidas).
- Exercícios curtos e práticos; links gratuitos quando fizer sentido.

**Diferença em uma linha:** o Analyst diz *o que aconteceu* ("82% das mortes sem trade"); o Coach diz *o que fazer* ("esse é o maior problema; treinem em duplas e façam este exercício").

### 6.3 Pagamento mensal — **NÃO FEITO**
- Fluxo planejado: botão "Assinar" → página de pagamento do serviço → o serviço avisa o Worker (webhook) → o Worker confere a assinatura do aviso e libera o plano até a data (`planos.ate`) → ao cancelar ou falhar, expira sozinho.
- Opções com **custo fixo zero** (só taxa por venda): Mercado Pago, Stripe Brasil, Asaas. **Pix Automático** (recorrência no Pix) é novo e **precisa ser verificado** quanto a quais serviços já oferecem.
- Será preciso: conta de recebimento (CPF ou CNPJ), tela para o dono ver e cancelar a assinatura, período de teste opcional.
- Falar com um contador sobre MEI e impostos (o Claude não é contador).

### 6.4 Parte legal e riscos — **NÃO FEITO**
- Termos de uso e política de privacidade (LGPD).
- **Risco com a Valve**: cobrar por um serviço feito sobre a leitura de demos pode chamar atenção. Ler os termos da Valve antes de cobrar. **Não verificado.**
- Não usar o nome nem a marca Counter-Strike como nome do produto.

### 6.5 Para ligar o Pro num time manualmente (enquanto não há pagamento)
No console do D1:
```sql
INSERT OR REPLACE INTO planos (cla_id, ate, origem)
SELECT id, 4102444800000, 'manual' FROM clas WHERE slug='SLUG-DO-TIME';
```
`SLUG-DO-TIME` = final do endereço do time, depois de `#/cla/` (nome em minúsculas, sem acento, com hífens).

### 6.6 Plano individual (Ranko Individual) — **FEITO, em teste**
Assinatura pessoal, à parte do Pro do time. Fica no perfil de quem está logado. Ainda é liberado à mão, conta por conta.

**Formulário (decidido pelo Juan):** pretensão (chegar a um rank, jogar melhor, me divertir mais), meta de faixa Premier (só com rating; sem rating a opção "chegar a um rank" fica desativada e o caminho é "jogar melhor"), tempo por dia (30 min a 3 h) e dias por semana, equilíbrio entre treinar e jogar, hábitos (DM e mapa de bots).

**Rotina (regras escritas à mão, zero IA):**
- Parte do tempo diário que vira treino: treinar mais 50%, um pouco de cada 25%, jogar mais 15%, divertir 10% (valores iniciais, a calibrar). Mínimo de 10 min.
- Aquecimento de mira de 10 min (5 min se o treino for menor que 20) e blocos de foco nos dois pontos mais fracos entre mira, utilidade, posicionamento e abertura. Exige 3 ou mais partidas analisadas; sem isso a rotina é genérica (mira e utilidade) e avisa.
- Meta de rank: sobe de "escadinha" (a primeira etapa é a faixa seguinte). Se a meta for 2 ou mais faixas acima, o site avisa que não é recomendado.
- Gráfico do rating ao longo do tempo, com a linha da meta.
- O bloqueio é no servidor (tabela `planos_ind`).

**Para liberar o plano individual de uma pessoa (console do D1):**
```sql
INSERT OR REPLACE INTO planos_ind (steam64, ate, origem) VALUES ('STEAM64-DA-PESSOA', 4102444800000, 'manual');
```
(`STEAM64-DA-PESSOA` = os 17 dígitos que aparecem depois de `#/jogador/` no endereço do perfil.)

**Selo de rating:** desenho próprio do Ranko (bloco com a cor da faixa e o número), mostrado no perfil, no pódio, no ranking e nas listas do time, para quem tem rating lido. A cor segue as 7 faixas do Premier: cinza (abaixo de 5.000), azul-claro (5.000), azul (10.000), roxo (15.000), rosa (20.000), vermelho (25.000) e amarelo (30.000 ou mais). **Não copiar o desenho do selo do jogo nem de outros sites.**

**Não verificado:** a aparência real do selo na tela; o comportamento do robô com muitos amigos (tempo de execução); preço, cobrança e a regra da Valve para cobrar (ver 6.3 e 6.4).

---

## 7. Estado atual e o que o Juan precisa fazer

**Entregue, mas ainda não publicado:**
- `index.html` (Simples/Pro, modo Pro sem brincadeiras, botão Pro brilhante, fotos em Mapas e funções, Analyst).
- `worker.js` (proteção, partidas do time, Analyst, planos).
- `schema.sql` (tabelas `analise_partida` e `planos`).
- `demos/analise.mjs` (novo) e `demos/ler-demos.mjs` (alterado).

**Ordem para publicar:**
1. **D1**: criar as duas tabelas novas (comandos `CREATE TABLE IF NOT EXISTS` do `schema.sql`).
2. **Worker**: colar o `worker.js` novo e dar Deploy.
3. **Robô**: enviar `analise.mjs` para a pasta `demos` e substituir `ler-demos.mjs`.
4. **Site**: substituir o `index.html` e dar Ctrl+F5.
5. **Ligar o Pro** no time (seção 6.5).

**Pendências antigas do Juan:**
- Confirmar o subdomínio `rankoguy` no Cloudflare.
- Atualizar o segredo `WORKER_URL` no GitHub para `https://painel-login.rankoguy.workers.dev`.
- Publicar o README e remover banners duplicados no repositório (opcional).

**Limites que valem lembrar:**
- Só ganham análise as partidas lidas **depois** de publicar o robô novo. Partidas antigas não têm como ser recuperadas (o robô guarda só o último código; as demos expiram).
- Não foi possível testar o robô com download real da Steam fora do sandbox, nem verificar o Worker publicado; só o mesmo código lendo demos locais.
- O texto de ajuda dos códigos (como a Steam descreve cada um) não foi verificado na página real.

### Estado em 10/11/2026 (atualizado depois da seção acima, de 09/11)

> A lista de 09/11 acima pode estar desatualizada: o plano individual aparece no site, o que indica que o Worker e o site novos já estão no ar. O que não foi conferido está marcado.

**Feito e no ar (conferido pelo Juan):** Worker com as rotas do plano individual; tabelas `plano_individual`, `rating_hist` e `planos_ind` criadas no D1; formulário e rotina funcionando no perfil.

**Conta Ranko (robô separado da conta pessoal), segundo as anotações da outra conversa:** o robô não usa mais a conta pessoal. Conta própria do Ranko, sem limite (US$ 5 gastos), com amizade com a conta pessoal e Steam Guard no celular. Chave da API e token de acesso gerados na conta Ranko e guardados nos segredos do GitHub (`STEAM_API_KEY`, `STEAM_REFRESH_TOKEN`); a chave antiga da conta pessoal foi revogada em 10/11. O token vence em cerca de 6 meses e é refeito com `npm run login` na pasta de teste `ranko-robo`. O teste leu o rating Premier da conta pessoal do Juan, amiga da conta Ranko.

**Entregue em 10/11, ainda sem confirmação de publicação:** `worker.js`, `index.html` e `demos/ler-demos.mjs` com o selo de rating e a leitura de rating para todo amigo da conta Ranko com a leitura ligada. Ordem de publicação: Worker, depois robô e site.

**Última rodada do robô (10/11):** falhou com "API da Steam 500" e "não conectou ao servidor do CS2". A suspeita é instabilidade ou manutenção da Steam na terça à noite; **não confirmado**. Rodar de novo com a Steam normal.

#### Quadro de pendências (antigo, de 10/11; o atual é o de 14/11, mais abaixo)

**1. Testes do rating Premier (agora)**
- [ ] Rodar o robô com a Steam normal e conferir que gravou os ratings.
- [ ] Conferir o selo no perfil, no pódio, no ranking e na lista do time.
- [ ] Conferir no plano individual que o rating aparece como lido da Steam e que as faixas de meta têm as cores certas.
- [ ] Cloudflare: confirmar que a variável da chave da Steam foi recriada com o mesmo nome, como Secret, com Deploy feito.

**2. Visual (depois)**
- [ ] Lista a ser feita pelo Juan. Já há um sistema visual novo (feito em 08 a 10/11 só com CSS) para respeitar.
- [ ] Ver o selo de rating na tela e ajustar cor e tamanho, se preciso.

**3. Funcionalidades (depois)**
- [ ] Mandar o link de convite da conta Ranko para a galera (o robô só enxerga rating e partidas de quem for amigo dela).
- [ ] Selo de rating no cartão "Baixar cartão para postar" (não incluído).
- [ ] Patentes Competitivo e Wingman (hoje só o Premier).
- [ ] Lista de mapas de treino do plano individual (o Juan indica quando chegar a hora).
- [ ] Ranko Coach (seção 6.2), pagamento (6.3) e parte legal (6.4).

**4. Correções (depois)**
- [ ] Nenhuma registrada. O que o Juan anotar entra aqui.

---

### Estado em 11/11/2026

**Feito e conferido pelo Juan:** rating Premier lido pelo robô (4 de 4 amigos) e selo no ar; robô a cada 30 min; convite automático de amizade (a conta Ranko adicionou os pendentes); botão **Atualizar agora** (depois de dar a permissão Actions ao token, a rodada entrou no GitHub).

**Visual entregue nesta rodada (esteira do visual):** selo só com o número, com respiro e brilho menor; cartão "Baixar cartão para postar" segue o modo claro/escuro e tem o selo; limpeza de textos (Minha função com botão ao lado do título, mapas de conforto primeiro, plano individual reorganizado, textos do clã enxugados); ícone de informação (i) para dicas e observações.

**Pausado por decisão do Juan (12/11):** redesenho do cabeçalho do jogador (card do rating com fundo na cor da faixa, cantos retos, número menor). Ficou guardado em `index-cabecalho-novo.html`; o site no ar segue com o cabeçalho anterior (selo por faixa ao lado das tags). Retomar só quando ele pedir.

**Aguardando:** as duas pessoas pendentes aceitarem o convite (depois a rodada deve mostrar "Ratings lidos: 6 de 6"); ver o convite por link sendo aceito sozinho (ninguém usou o link ainda).

**Faixa Perfil (12/11), PUBLICADO e funcionando:** histórico de partidas no perfil (mapa, data, placar, Rank, abates, mortes, K/D; filtros Todas/Vitórias/Derrotas; sem rating da Leetify), tela da partida em `#/partida/<id>/<jogador>` com os dois times (abates, assist., mortes, K/D, ADR, KAST, 2K a 5K e Rank) e análise da partida com trava para quem não tem o plano individual. O Rank das duas telas é o **rating Premier lido no dia da partida** (último de `rating_hist` até o dia); só existe para quem está no painel. Coluna Rank com selos de largura fixa (resolve o desalinhamento do mock). Testes: 26 verificações do Worker com SQLite de verdade, 21 do site no navegador (histórico, tela, trava, mobile, claro/escuro) e teste sintético do cálculo de placar/KAST.
**Não verificado (depende da Valve):** modo da partida (Premier/Competitivo) e rank **na hora** da partida; por isso não há filtro por modo ainda.
**Ordem de publicação do Perfil:** (1) rodar `schema-partidas.sql` no D1; (2) colar o `worker.js`; (3) subir `demos/ler-demos.mjs` no repositório; (4) subir o `index.html`; (5) rodar o robô (Atualizar agora) e abrir o perfil.

### Estado em 13/11/2026
- Histórico do perfil e lista **Partidas do time** abrem a tela da partida (os 10 jogadores) nas partidas lidas a partir de 12/11. Partidas antigas não têm os outros jogadores e não serão recuperadas (decisão do Juan).
- **Partidas do time:** mínimo de **3** membros na mesma partida (antes 4; constante `MINIMO_TIME` no Worker, vale também para o Analyst). Cada linha mostra "+N complete(s)" (5 − membros). Aberta pela lista do time, a tela da partida mostra **Voltar ao time** e a **análise do time** (Time Pro); aberta pelo perfil, mostra a análise individual. Só a linha de quem está logado fica destacada.
- Leitor reserva `cs2parser` no ar; bibliotecas travadas; filtro do log público; revisão de segurança feita (seção 5).
- Rodada de 13/11: 7 pessoas com leitura ligada, ratings 5 de 5, 2 pessoas ainda não amigas da conta Ranko.

### Estado em 14/11/2026
- O `index.html` enviado pelo Juan em 14/11 passou a ser o **oficial** e a base das próximas mudanças. Ele tem as abas, Minhas funções e o polimento da tela da partida, mais ajustes feitos fora desta conversa: busca vira lupa no celular, botão Pro sem brilho animado, análise do time em linhas, faixa de abas do time escondida (a troca de aba é pelo menu lateral e pelo de baixo) e faixa de abas do perfil grudada abaixo da barra de cima. Todos os testes passaram nele.
- **Abas (13/11):** perfil com Meu desempenho, Partidas, Minhas funções e Plano individual; time com Visão geral, Partidas, Mapas e Trollagem (modo simples) ou Time Pro no lugar de Trollagem (modo Pro). Cada aba tem endereço próprio (`#/jogador/<id>/funcoes`, `#/cla/<slug>/mapas`).
- **Minhas funções (13/11):** modo ver (resumo) e modo editar (seleções de uma escolha, "mesma posição em todos os mapas", limite de 3 mapas com aviso). O "O que já é possível ver no seu jogo" foi para a aba Meu desempenho.
- **Diagnóstico pessoal:** só a própria pessoa vê (análise individual). A análise do time, por partida e no panorama, não leva diagnóstico de ninguém (decisão do Juan, 13/11).

- **Cabeçalho do perfil (14/11):** cabeçalho separado das abas; abas em formato de ficha, a ativa com o texto na cor de destaque.
- **Selo de rating novo (14/11), desenho do Juan no Figma:** barrinha solta na cor da faixa, caixa com a lateral esquerda cheia, borda fina e cantos arredondados só à direita, número em itálico (Overpass itálico, carregado do Google Fonts). Cores por faixa: cinza #9ca3af, azul-claro #93c5fd, azul #3b82f6, roxo #a855f7, rosa #ec4899, vermelho #ef4444, amarelo #facc15, cada uma com fundo escuro próprio (lista `RT_F`). O cartão para postar usa o mesmo desenho. Cabeçalho e selo sobem juntos no mesmo `index.html`.

#### Quadro de pendências (14/11/2026)

**Aguardando o Juan**
- [ ] Conferir se o `worker.js` de 13/11 (sem diagnóstico na análise do time) foi publicado no Cloudflare.
- [ ] As 2 pessoas que ainda não são amigas da conta Ranko aceitarem o convite (rodada de 13/11: 7 com leitura ligada, ratings 5 de 5).
- [ ] Usar as abas por alguns dias e dizer o que juntar ou separar.

**Funcionalidades**
- [ ] **Guardar os dados para sempre (novo, 14/11).** Três partes:
  1. Parar de apagar: histórico partida a partida e quadro dos 10 (hoje 90 dias), análise de rounds (60 dias), histórico do rating (400 dias). Medir o tamanho real antes.
  2. "Resumo da demo": guardar os eventos enxutos de cada partida (mortes, dano, fins de round, flashes, granadas, times) para recalcular números novos e corrigir erros nas partidas antigas sem precisar da demo. O robô mede o tamanho no log; depois decidir entre D1 e R2.
  3. Filtros no perfil: últimos 30 dias, últimos 90 dias e desde o cadastro. Os rankings do time (semana, mês, geral) continuam.
  Não guardar as demos inteiras (200 MB cada; os 10 GB grátis do R2 cabem umas 50). Partidas e demos já apagadas não voltam.
- [ ] Modo da partida (Premier/Competitivo) e rank na hora da partida: falta rodar o robô com `DEPURAR_RATING=sim` e olhar a linha "(partida: campos …)".
- [ ] Patentes Competitivo e Wingman (hoje só o Premier).
- [ ] Lista de mapas de treino do plano individual (o Juan indica quando chegar a hora).
- [ ] Analyst: olhar com 20 a 30 partidas reais e calibrar os diagnósticos.
- [ ] Ranko Coach (6.2), pagamento (6.3) e parte legal (6.4), com política de privacidade e termos antes de abrir ao público ou cobrar.
- [ ] Voltar a usar o `demoparser2` quando ele abrir as demos do patch novo (decisão do Juan, com a avaliação de quem publicou a versão).

**Visual**
- [ ] Redesenho do cabeçalho do jogador: **pausado** pelo Juan.
- [ ] Redesenho das Conquistas: em aberto.
- [ ] Vídeo de lançamento: atualizar a cena 7 e as telas para o design atual.

**Segurança e riscos (abertos)**
- [ ] Backup do D1: o plano grátis volta o banco no tempo só até 7 dias; exportar uma cópia de vez em quando.
- [ ] Conta-robô pode sofrer restrição da Valve (usar só para isso).
- [ ] Sessão de 30 dias sem como derrubar uma só (trocar `SESSION_SECRET` derruba todas).

**Correções**
- [ ] Nenhuma registrada.

**Aprendizado de processo:** ao propor biblioteca nova, avaliar antes quem mantém e a que segredos ela terá acesso (o `cs2parser` entrou sem essa avaliação e foi travado depois). Erro do botão agora mostra o código do GitHub (403 = falta permissão no token, 404 = repositório/arquivo, 422 = ramo, 401 = token vencido).

---

## 8. Para onde o projeto vai (ordem sugerida)

1. **Publicar o Analyst** e olhar com partidas reais de 20 a 30 jogos; **calibrar** os limites dos diagnósticos.
2. **Ranko Coach** (regras, exercícios, comparação entre partidas).
3. **Plano e período de teste** (quem paga, quanto, teste grátis).
4. **Pagamento mensal** (escolher serviço, webhook, tela de assinatura).
5. **Parte legal** (termos, privacidade, ler os termos da Valve).
6. **Lançamento** primeiro só para o time do Juan, depois para os amigos.
7. **Pausado:** Awpy, leitura por tick, Match Intelligence Engine, domínio próprio.
8. **Em aberto:** redesenho das Conquistas; vídeo de lançamento (existe roteiro em doc do Claude; a cena 7 ainda menciona "colar o que copiou da página", que precisa virar "dois códigos"); novas telas do vídeo com o design atual.

---

## 9. Como retomar uma conversa nova (o que dizer ao Claude)

> "Leia o `PROJETO.md` anexo. Hoje a faixa é [visual | funcionalidades | correções]. Quero [Y]. Se precisar de um arquivo, me diga qual."

Anexe só o que for necessário (por exemplo, `worker.js` ou `index.html`), não tudo, e **sempre a versão atual do repositório** (ver a regra 1 da seção 0). Os arquivos finais ficam no repositório `rankoguy/ranko`; **a fonte da verdade é o que está publicado lá**, não a memória da conversa.

**Observação técnica para o Claude:** o ambiente de trabalho do Claude é temporário. Qualquer arquivo de teste ou rascunho pode sumir entre sessões. Se precisar de testes, recrie-os; os entregáveis ficam nos arquivos anexados e no repositório.

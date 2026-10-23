---
name: vps-performance-review
description: "Solicite e interprete medições Lighthouse na VPS pelo Performance Observatory do Paperclip, ou consulte seu histórico por ferramentas de agentes, API e CLI. Use para reviews de performance, comparação de builds e métricas de cache frio/quente nesse executor; não para instalar infraestrutura ou alterar o app automaticamente."
---

# Medir performance usando a VPS

Use o **Performance Observatory** do Paperclip. O plugin agenda e guarda resultados; um controlador
leve inicia um container de navegador **somente quando existe uma execução** e o remove ao concluir.
Não depende de CI, servidor LHCI permanente ou Chrome no computador do usuário.

## Escolher a operação

- **Histórico ou métricas já coletadas:** liste execuções e leia os detalhes; não solicite uma nova medição.
- **Review nova:** descubra o alvo configurado e solicite uma execução assíncrona com chave idempotente.
- **Comparação:** encontre uma baseline compatível e compare coortes completas. Resultados antigos não
  comprovam o estado atual de produção.

Leia [comandos e contratos](references/commands.md) para a ferramenta, API ou CLI disponível.
Use [operação na VPS](references/vps-operations.md) somente para conferir instalação, diagnosticar
coleta inválida ou comprovar o encerramento de um executor. A medição normal não exige SSH.

## Solicitar e acompanhar

1. Liste os alvos e confirme **empresa/projeto, ambiente, cenário e dispositivo**. Não invente targetKey,
   rota, sessão ou IDs de execução. Um ambiente oferecido pela interface não significa que tenha fixture
   e perfil autenticado homologados. Se faltar o alvo, registre essa dependência e continue consultando
   as evidências disponíveis, sem substituir staging por produção.
2. Gere uma `requestKey` nova para o pedido lógico e preserve-a em retentativas. Guarde o `runId`
   retornado. Repetir o mesmo alvo/chave retorna a mesma execução; uma chave nova cria outra revisão.
3. Consulte esse run, sem reenviar o pedido porque ele está `queued` ou `running`. O job de reconciliação
   pode levar cerca de um minuto para iniciar; há fila serial. Use intervalos de 30–60 segundos para
   acompanhar, sem despejar cada polling na conversa. Se a janela de acompanhamento terminar,
   registre o ID e o estado pendente no Paperclip; não invente falha, sucesso ou uma nova tentativa.
4. Ao terminar, leia o detalhe com as amostras. Preserve falhas e resultados abaixo da meta. Repita uma
   coleta apenas por razão identificada, registrando o vínculo com a tentativa anterior; não repita até
   obter um número favorável.

Solicitar uma review não autoriza deploy, mudança de Auth/RBAC/TTL, troca de imagem/configuração,
criação de fixtures ou edição do frontend. Faça essas ações somente dentro do escopo já autorizado.

## Avaliar a evidência

A revisão padrão exige **três amostras frias + três quentes**, sem duplicatas ou amostras ausentes,
com versão do Lighthouse/Chrome, build estável, rota/documento/rede válidos e métricas finitas.
Em alvos autenticados, o coletor também valida DOM real e controle negativo sem sessão.
Confira `samples`, `cohorts`, `buildId`, `lighthouseVersion`, `chromeVersion`,
`noSessionControlPassed` e `readinessScope` quando aplicáveis.

| Estado | Como relatar |
|---|---|
| `queued` / `running` | Revisão pendente; sem conclusão de performance. |
| `failed` | Coleta inválida/interrompida; informar `error_code`, sem transformar em score zero. |
| `passed` | Coleta válida que atingiu a meta configurada. |
| `regression` | Coleta válida **abaixo da meta**; o nome não comprova regressão causal. |

- Use as **médias aritméticas das três amostras** de cada cache, não o melhor score ou a mediana.
  Para o Tessel, a meta atual é média quente **>94** e fria idealmente **>70**; igualdade não passa.
  Confira a régua devolvida em `cohorts[].goal`, sem impor essa meta a outro projeto.
- Frio significa **cache HTTP do navegador limpo**. Não significa Auth/KV/DB/CDN/backend frio.
  Não limpe caches de produção para mudar o significado da coleta.
- `uiReadyMs` é o tempo da jornada na preparação. A prova de DOM autenticado também ocorre na
  navegação auditada, mas esse tempo não é o LCP nem um span de API; não some essas métricas.
- Use `/version.json`/`buildId` como identidade do artefato implantado. SHA Git e hashes Vite são
  identidades distintas: não procure SHA Git nas URLs dos assets para provar o build.
- Antes de atribuir ganho ou regressão, mantenha comparáveis alvo, ambiente, cenário, dispositivo,
  cache, engine, fixture, imagem/limites do executor e carga da VPS. Consulte `execution` nos detalhes.
  Metadados ausentes em uma execução antiga são **desconhecidos**, não zero ou equivalentes.

## Investigar APIs ou frontend

O resumo Lighthouse guarda contagem de requests e bytes, não latência individual de Auth/RPC.
Não conclua que a API é lenta só pelo score, LCP, TBT ou número de requisições. Correlacione a mesma
janela/build/execução com telemetria existente e timings de requests. No Tessel, siga o contrato
`@tessel/utils/telemetry` e `docs/operation-telemetry.md`; não adicione SDK de fornecedor ao browser.
Não some durações de spans aninhados ou requisições paralelas para calcular a espera total.
Se faltarem dados, separe a hipótese da evidência e indique a instrumentação necessária.

## Sessão, isolamento e relatório

- Use o perfil sintético próprio do ambiente na VPS. Não copie cookies/tokens do Chrome pessoal nem
  compartilhe a família de refresh token do capturador UX canônico. Não leia/mostre `.keys`, estados
  de autenticação, variáveis de outros containers ou `/proc` para obter credenciais.
- O fluxo de leitura não envia mensagens, cria conversas nem chama geração de IA/créditos.
  Falta/expiração de perfil é dependência operacional, não justificativa para medir a tela de login.
- Não abra CDP/relatórios publicamente, mantenha browser ocioso ou relaxe usuário/rede/mounts para
  fazer uma coleta passar. Reiniciar o controlador não é uma etapa necessária de toda medição.
- Para uma prova operacional, confira a remoção do **executor daquele run**. Se houver outra coleta
  legítima na fila, não exija zero containers nem mate processos de terceiros.
- Publique apenas o JSON sanitizado e evidências resumidas. LHR bruto pode conter URLs e conteúdo
  privado; não o envie à conversa, GitHub ou serviço público. O histórico SQL preserva inclusive
  falhas; limpeza de arquivos de entrega antigos não é exclusão desse histórico.

Registre no Paperclip o runId/link, data e fuso, alvo/ambiente/cenário/dispositivo, build/engine,
amostras por cache, médias e metas. Inclua LCP/FCP/TBT/CLS, requests/bytes e `uiReadyMs` conforme a
pergunta; não omita limitações ou confunda pipeline válido com meta atingida. Use UTC para
correlacionar logs e apresente horários ao usuário no fuso dele.
Mantenha o trabalho periódico e os recibos no Paperclip; devolva à conversa uma conclusão curta com
links. Crie/edite tarefas ou agendamentos somente quando isso fizer parte do pedido autorizado.

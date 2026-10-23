# Instalação e diagnóstico na VPS

Use primeiro API/ferramentas. Este guia descreve o contrato do executor; valores da instalação
(host, empresa, projetos, caminhos e perfis) vêm do registro operacional privado autorizado.
Confirme instalação/host antes de usar SSH; não recorra a uma VPS antiga por lembrar um endereço.
Não modifique infraestrutura durante um pedido apenas de métricas.

## Descobrir a instalação

| Recurso | Como conferir |
|---|---|
| Painel e empresa | Contexto real do Paperclip; não reutilizar IDs de outra instalação |
| Alvos e cadência | `list_targets`/API; conferir ambiente, cenário, dispositivo e homologação |
| Plugin | Versão/status pela API nativa; não presumir a versão a partir deste guia |
| Engine | Versões reais do Lighthouse e Chrome em cada resultado |
| VPS e acesso SSH | Registro privado autorizado; não copiar host, usuário ou chave de outro ambiente |
| Fonte | `journey-studios/paperclip-plugins`, `plugins/performance-observatory` e `services/performance-runner` |
| Controlador e serviço | Registro operacional privado e README do runner; confirmar o nome instalado |
| Rede do executor | Rede egress isolada configurada, sem acesso ao host/peers/redes privadas/metadados |
| Executor | container `perf-RUN_ID`, label `journey.performance=true`, removido por Docker `--rm` |
| Dados e sessão sintética | Diretórios privados configurados por ambiente; **não ler** o estado de autenticação |
| Recibos e dependências | Issues e execuções da empresa/projeto confirmados no contexto atual |

Suporte implementado a staging/test e home-to-chat não comprova homologação operacional. Descubra
a situação atual pelo catálogo/execuções e pelo responsável pelas fixtures e sessões de cada ambiente.
Não presuma homologação nem substitua um ambiente ausente por produção.

## Conferência de leitura

Com acesso SSH já autorizado, execute apenas o que responder à dúvida. Exemplos dentro da VPS,
substituindo `SERVICO_CONTROLADOR` pelo serviço confirmado e `RUN_ID` pelo ID real:

```sh
systemctl is-active SERVICO_CONTROLADOR
docker ps --filter label=journey.performance=true --format '{{.Names}} {{.Status}}'
docker inspect perf-RUN_ID --format '{{.Config.User}} {{.HostConfig.NetworkMode}} {{.State.StartedAt}}'
```

Um container de run concluído ausente é esperado; outro run legítimo pode estar medindo.
Não rode `docker inspect` completo, imprima ambiente, leia tokens/perfis ou use `docker prune`.
Não reinicie serviços ou dispare outro browser como rotina de consulta. Falha do controlador não
autoriza reiniciar o Paperclip inteiro ou o capturador UX canônico.

O contrato do runner usa UID/GID 1001:1001, limite de 2 CPUs/3 GiB/512 PIDs, filesystem read-only,
tmpfs e capacidades removidas. Confirme a implementação instalada; leia `result.execution` para
imagem imutável, recursos, duração e carga antes/depois. Não altere a máquina ou limites entre baseline
e candidato para atribuir melhora ao app. Registre carga/concorrência; não compare esses dados
diretamente com Mac.

## Configuração, sessão e rede: somente quando estiverem no escopo

- Alvos ficam nas configurações nativas do plugin, vinculados a projeto/empresa. O controlador
  permite somente origens/perfis configurados; URLs com credenciais, query ou fragmento são rejeitadas.
- `home-to-chat` precisa de `startUrl`, seletor de entrada e, se necessário, seletor de conversa
  existente. O Lighthouse audita a URL final; a preparação mede a jornada separadamente.
- Perfis de prod/staging/test são separados. Renovação da sessão é persistida atomicamente antes
  de fechar cada browser. Diretórios 700/arquivos 600, com proprietário compatível com o runner.
  O fluxo de seed existente deve conferir identidade e origem, usando segredos já autorizados
  sem mostrá-los; não extraia credenciais de outros processos. Não altere Auth/JWT/RBAC/TTL.
- Não compartilhe o perfil com `tessel-ux-capture`. Ele tem sessão e ciclo operacional próprios.
  Falta de credencial/fixture deve ser registrada para o responsável, sem usar sessão pessoal.
- Não abra CDP/controlador público nem conecte o executor a `agents-net`. Um resolver DNS privado,
  se necessário em outra instalação, pede exceção específica e prova de isolamento; não libere
  genericamente redes privadas/porta53 para contornar um erro.
- Operação do executor não usa Wrangler nem GitHub Actions. Mudar/deployar o app é outro escopo;
  siga o fluxo de deploy do repositório em vez de transformar a medição em um deploy implícito.

## Persistência e falhas

O controlador recupera o índice de pendentes no startup; não depende de um browser permanente.
Paperclip reconhece a entrega **depois** de salvar o resultado terminal no SQL. Só pastas terminais
confirmadas há mais de sete dias podem ser limpas; pendentes e entregas sem ack permanecem.
O histórico SQL, incluindo falhas e scores baixos, não é apagado por essa limpeza.

Consulte `error_code` e o recibo sanitizado antes de qualquer correção. Para problemas do coletor,
leia os fontes e testes em `services/performance-runner`; não exporte LHR bruto para investigar.
Uma revisão inválida não comprova regressão do Tessel e não autoriza relaxar seus gates.

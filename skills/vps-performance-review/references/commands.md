# Comandos e contratos

Plugin: `journey-studios.performance-observatory`.
Escolha o transporte já disponível; não instale outro executor ou copie credenciais só para consultar.

## Agentes executando no Paperclip

Descubra as ferramentas registradas do plugin. O prefixo pode aparecer separado do nome na UI:

```text
list_targets({})
request_review({targetKey: "prod-chat-reload", requestKey: "CHAVE-NOVA-DESTE-PEDIDO"})
list_runs({targetKey: "prod-chat-reload", environment: "prod", limit: 20})
get_run({runId: "ID-DEVOLVIDO-PELO-PEDIDO"})
```

A identidade da empresa vem da execução real do agente. Não forneça empresa no payload dessas
ferramentas nem fabrique `runContext`. Uma API key de agente não equivale a uma board API key.

## Codex/ChatGPT pelo conector Paperclip

Se as quatro ferramentas não estiverem expostas no conector externo, use o `paperclipApiRequest`
existente. Ele acrescenta `/api`: passe o caminho **sem** esse prefixo.

```text
GET /plugins/journey-studios.performance-observatory/api/targets?companyId=EMPRESA
POST /plugins/journey-studios.performance-observatory/api/reviews?companyId=EMPRESA
GET /plugins/journey-studios.performance-observatory/api/runs?companyId=EMPRESA&limit=20
GET /plugins/journey-studios.performance-observatory/api/runs/RUN_ID?companyId=EMPRESA
```

Corpo do POST (o argumento `jsonBody` do conector recebe o JSON serializado):

```json
{"targetKey":"prod-chat-reload","requestKey":"CHAVE-NOVA-DESTE-PEDIDO"}
```

Leia `data` na resposta. Descubra a empresa no contexto autorizado; não use IDs de outra instalação.
Consultar `runs` retorna resumos; `runs/:id` retorna as seis amostras e metadados completos.

## HTTP ou CLI fora da VPS

Os mesmos caminhos HTTP completos começam com `/api/plugins/...` e exigem sessão de board ou
board API key autorizada. Sem autenticação, a instalação atual responde HTTP 403.
Não exponha o controlador privado para atender clientes externos: use o Paperclip.

O pacote `@journey-studios/performance-observatory` contém `bin/performance.mjs` e o binário
`performance`. Se já estiver instalado no cliente:

```sh
performance targets
performance review prod-chat-reload
performance runs prod-chat-reload --environment prod --limit 20
performance show RUN_ID
```

O cliente precisa de Node com `fetch` e lê `PAPERCLIP_API_URL` (origem raiz), `PAPERCLIP_API_KEY`
e `PAPERCLIP_COMPANY_ID` do ambiente, fornecidos pelo secret manager autorizado. Nunca coloque
o valor da key em argumento/URL/chat. Para retries, defina `PERFORMANCE_REQUEST_KEY` com um UUID
novo por pedido lógico e preserve seu valor; se omitido, cada chamada `review` gera uma chave nova.

Se o binário não estiver no PATH, use `node /caminho/do/pacote/bin/performance.mjs ...` em um
cliente com Node. A existência do serviço Python na VPS não implica Node no host. Não declare que
a CLI está globalmente instalada só porque ela está empacotada.

## Paginação sem perder execuções

`list_runs`/GET runs aceitam `targetKey`, `environment`, `limit` (padrão 20, máximo 200), `before`
e `beforeId`. Para a página seguinte, use o `created_at` **exato** e o `id` da última linha:

```text
list_runs({limit:20, before:"CREATED_AT-EXATO", beforeId:"ULTIMO-ID"})
performance runs --limit 20 --before "CREATED_AT-EXATO" --before-id ULTIMO-ID
```

Em HTTP, codifique os valores como query parameters. Não arredonde o timestamp nem o converta
para `Date` antes de reutilizá-lo: o cursor tem microssegundos. `created_at_display` é UTC ISO
próprio para exibição/gráficos; não o use como substituto do cursor.

## Falha, demora e retentativas

- `queued`/`running`: acompanhe o mesmo ID; o POST não é síncrono.
- `error_code` em run ainda pendente pode indicar falha de transporte; não o declare terminal.
- `failed`: mostre o código e investigue a causa. Falta de perfil, build divergente ou evidência de
  autenticação ausente não se resolvem substituindo a URL por login ou escolhendo outra amostra.
- Rejeições permanentes HTTP400/404/409/413/422 do controlador terminam o run. HTTP429/5xx e
  indisponibilidade de rede continuam retomáveis; não crie uma fila de pedidos novos para contorná-las.

O scheduler nativo verifica a cada minuto. `targets[].enabled` liga o agendamento; um alvo sem
agendamento pode ser solicitado manualmente. O campo `source` automático é `schedule`.
Alterar a cadência é uma operação de configuração distinta de solicitar uma review.

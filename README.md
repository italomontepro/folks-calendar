# Folks Calendar

Agenda compartilhada com visualizações de mês, semana e dia, eventos persistidos em SQLite e automações por webhook. Interface em português, responsiva e com modo de incorporação para o CRM HELENA.

## Executar localmente

Requer Node.js 24.14 ou superior.

```sh
npm ci
cp .env.example .env
npm run dev
```

Abra http://localhost:5173. Sem `APP_PASSWORD`, o ambiente de desenvolvimento fica aberto. Configure a senha em `.env` para testar o login. Datas são exibidas no fuso do navegador e armazenadas em UTC. Eventos de dia inteiro usam término exclusivo: um evento do dia 10 termina à meia-noite do dia 11.

## Funcionalidades

- Criar, editar e excluir eventos com título, início, término, descrição, local/link, contato/ID no CRM, e-mail, agenda e lembrete.
- Visualizações de mês, semana e dia; navegação por período, busca e filtros por agenda.
- Agendas Reuniões, Tarefas e Pessoal, compartilhadas entre os usuários da instalação.
- Webhooks configuráveis, ativação/pausa, teste e histórico dos últimos 100 disparos.
- Atualização dos dados a cada 15 segundos.
- Autenticação por senha compartilhada, sessão de 12 horas guardada por aba e limite de tentativas de login.
- Modo `/?embed=1`, com navegação compacta.

## Publicação

Esta aplicação precisa de um servidor Node persistente e armazenamento persistente. Uma hospedagem exclusivamente estática não executa o banco nem a fila de webhooks.

```sh
npm ci
npm run build
NODE_ENV=production npm start
```

Configure:

| Variável | Uso |
| --- | --- |
| `APP_PASSWORD` | Senha longa e exclusiva para a equipe; obrigatória em produção. |
| `SESSION_SECRET` | Segredo aleatório estável; obrigatório em produção. Gere com `openssl rand -hex 32`. |
| `PORT` | Porta interna, padrão 3001. |
| `DATA_DIR` | Diretório persistente do SQLite, padrão `./data`. |
| `FRAME_ANCESTORS` | Origens autorizadas a incorporar a aplicação, separadas por espaço. Padrão `'self'`. |

Coloque um proxy HTTPS à frente da aplicação. Mantenha apenas **uma instância** do processo usando este banco. O processo precisa ficar ativo para executar os lembretes. Faça backups consistentes do SQLite (incluindo seu WAL, ou usando a ferramenta de backup SQLite); copiar apenas o arquivo principal durante gravações pode perder dados.

Há também um `Dockerfile`:

```sh
docker build -t folks-calendar .
docker run -d --name folks-calendar --restart unless-stopped \
  -p 3001:3001 --env-file .env \
  -e DATA_DIR=/app/data \
  -v folks-calendar-data:/app/data folks-calendar
```

O volume preserva os eventos, as configurações e a fila nas atualizações. Não exponha a porta sem HTTPS em produção. Esta versão usa acesso compartilhado; não oferece usuários individuais, permissões por pessoa ou múltiplas organizações isoladas.

## Incorporar no HELENA

1. Publique a aplicação em um domínio HTTPS.
2. Identifique a origem exata da página do seu CRM que incorpora sites externos.
3. Configure `FRAME_ANCESTORS` com `'self'` e essa origem. Exemplo **ilustrativo**, substitua pelo endereço real: `FRAME_ANCESTORS="'self' https://crm.sua-empresa.com"`.
4. Cadastre `https://seu-dominio.com/?embed=1` como site externo no HELENA.
5. Abra a integração e entre com a senha da agenda. O login não depende de cookies de terceiros.

Em um site que aceite HTML, a incorporação equivalente é:

```html
<iframe src="https://seu-dominio.com/?embed=1"
        title="Folks Calendar" width="100%" height="900"
        style="border:0" allow="clipboard-write"></iframe>
```

A integração dentro da conta HELENA ainda precisa ser validada no ambiente real. Esta aplicação fornece a página incorporável e webhooks genéricos; não pressupõe endpoints, API ou autenticação específicos do HELENA. Para acionar fluxos do CRM, use o receptor de webhook disponibilizado pelo fluxo ou um intermediário, como n8n/Make. Não há sincronização automática com eventos nativos do CRM.

## Webhooks

Cadastre em **Automações → Nova automação** o nome, a URL HTTPS pública (porta 443) e os gatilhos:

| Gatilho | Quando dispara |
| --- | --- |
| `event.created` | Ao criar um evento. |
| `event.updated` | Ao salvar alterações. |
| `event.deleted` | Ao excluir; o payload mantém os dados do evento excluído. |
| `event.reminder` | Antes do início, conforme o lembrete definido no evento. |
| `event.started` | Quando chega o horário de início. |
| `webhook.test` | Ao clicar em Testar webhook; não altera eventos. |

A fila e os registros de agendamento são persistentes. O worker verifica a fila a cada 5 segundos. Os horários são aproximados: a carga e o tempo de resposta dos destinos podem atrasar os envios. Após reiniciar, o worker recupera gatilhos vencidos de eventos cujo início ocorreu há no máximo 24 horas, incluindo lembretes vencidos. Não recupera eventos mais antigos. Criar um evento com horário de lembrete já vencido também coloca o lembrete na fila. Alterar início ou lembrete rearma os gatilhos agendados; editar apenas texto não rearma.

Tentativas: 5 no total, com espera de 30, 60, 120 e 240 segundos entre tentativas, mais o intervalo do worker. Apenas respostas HTTP 2xx contam como sucesso. Redirecionamentos não são seguidos. Cada chamada tem limite de 10 segundos. Endereços privados/reservados são bloqueados, e o DNS validado é fixado na conexão para evitar troca de destino durante o envio.

Pausar uma automação cancela seus envios pendentes quando o worker os processa; reativar não reproduz disparos antigos. Excluir a automação cancela a fila pendente. Uma chamada que já começou pode terminar mesmo após pausa ou exclusão.

Exemplo de payload:

```json
{
  "id": "uuid-da-entrega",
  "type": "event.created",
  "createdAt": "2026-09-13T18:00:00.000Z",
  "source": "folks-calendar",
  "data": {
    "id": "uuid-do-evento",
    "title": "Reunião com cliente",
    "start": "2026-09-14T13:00:00.000Z",
    "end": "2026-09-14T14:00:00.000Z",
    "description": "Apresentar proposta",
    "location": "https://reuniao.exemplo.com",
    "contact": "ID-do-contato-no-HELENA",
    "email": "cliente@exemplo.com",
    "category": "meeting",
    "allDay": false,
    "reminder": 15
  }
}
```

Cada automação tem um segredo gerado pelo servidor, disponível em **Configurar → Copiar segredo**. O header `X-Folks-Signature` contém `t=TIMESTAMP,v1=ASSINATURA`, sendo a assinatura HMAC-SHA256 hexadecimal de `TIMESTAMP.CORPO_JSON_ORIGINAL`. Valide sobre os bytes originais do corpo com comparação em tempo constante e rejeite timestamps muito antigos (por exemplo, mais de 5 minutos). `X-Folks-Delivery` é igual ao `id` do payload.

O receptor deve deduplicar pelo ID da entrega: se a resposta se perder depois de processar o evento, haverá reenvio com o mesmo ID. As entregas não garantem ordem entre si.

## Testes

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Os testes de API verificam autenticação, validação, bloqueio de destinos privados, persistência, CRUD, fila, cancelamento e disparos agendados. O teste de navegador cobre login, criação/edição/exclusão, persistência após recarga, três visualizações, busca, cadastro/pausa de automação e modo incorporado no celular. Usa banco separado em `test-results/`.

Referências técnicas: [Vite](https://vite.dev/guide/) e [SQLite no Node.js](https://nodejs.org/api/sqlite.html).

# Folks Calendar

Agenda com workspaces isolados por cliente, contas individuais e visualizações de mês, semana e dia, eventos persistidos em SQLite e automações por webhook. Interface em português, responsiva e com modo de incorporação para o CRM HELENA.

## Executar localmente

Requer Node.js 24.14 ou superior.

```sh
npm ci
cp .env.example .env
npm run dev
```

Abra http://localhost:5173. O login individual é obrigatório em todos os ambientes. No primeiro boot de desenvolvimento, sem `APP_PASSWORD`, o servidor gera uma senha em `data/bootstrap-admin.txt` para `admin@folks.local`. Configure `ADMIN_EMAIL` e `APP_PASSWORD` em `.env` para escolher o administrador inicial. Datas são exibidas no fuso do navegador e armazenadas em UTC. Eventos de dia inteiro usam término exclusivo: um evento do dia 10 termina à meia-noite do dia 11.

## Funcionalidades

- Criar, editar e excluir eventos com título, início, término, descrição, local/link, contato/ID no CRM, e-mail, agenda e lembrete.
- Visualizações de mês, semana e dia; navegação por período, busca e filtros por agenda.
- Workspaces por cliente, com agendas Reuniões, Tarefas e Pessoal em cada um.
- Administração Folks com acesso a todos os workspaces; membros acessam apenas os espaços aos quais foram convidados.
- Convites por link de uso único, válidos por 7 dias. Perfis administrador, editor e somente leitura.
- Gerenciamento de membros e origens HTTPS do HELENA por workspace.
- Webhooks configuráveis, ativação/pausa, teste e histórico dos últimos 100 disparos.
- Atualização dos dados a cada 15 segundos.
- Autenticação por e-mail e senha individual (hash scrypt), sessões revogáveis de 12 horas guardadas por aba e limite de tentativas.
- Troca de senha encerra todas as sessões da pessoa. Sair revoga a sessão atual.
- Modo `/?workspace=ID&embed=1`, com navegação compacta e autorização por workspace.

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
| `ADMIN_EMAIL` | E-mail do administrador global inicial; obrigatório no primeiro boot em produção. |
| `APP_PASSWORD` | Senha inicial do administrador (12–256 caracteres); obrigatória no primeiro boot em produção. |
| `PORT` | Porta interna, padrão 3001. |
| `DATA_DIR` | Diretório persistente do SQLite, padrão `./data`. |
| `FRAME_ANCESTORS` | Origens globais autorizadas a incorporar a aplicação. Padrão `'self'`; prefira configurar as origens por workspace na interface. |
| `TRUST_PROXY_HOPS` | Número de proxies confiáveis até o app. No EasyPanel com Traefik, use `1`, mantendo a porta do app sem exposição direta. |

Coloque um proxy HTTPS à frente da aplicação. Mantenha apenas **uma instância** do processo usando este banco. O processo precisa ficar ativo para executar os lembretes. Faça backups consistentes do SQLite (incluindo seu WAL, ou usando a ferramenta de backup SQLite); copiar apenas o arquivo principal durante gravações pode perder dados.

Há também um `Dockerfile`:

```sh
docker build -t folks-calendar .
docker run -d --name folks-calendar --restart unless-stopped \
  -p 3001:3001 --env-file .env \
  -e DATA_DIR=/app/data \
  -v folks-calendar-data:/app/data folks-calendar
```

O volume preserva os eventos, as configurações e a fila nas atualizações. Não exponha a porta sem HTTPS em produção. O isolamento é lógico no mesmo banco: eventos, webhooks e entregas possuem `workspace_id`, validado no servidor. Apenas a administração Folks acessa todos os clientes. O banco físico e os backups continuam compartilhados; não existe banco separado por cliente. Mantenha uma réplica e `zeroDowntime=false` no EasyPanel para evitar dois workers simultâneos durante deploys.

## Workspaces e acesso

1. Entre com o e-mail do administrador Folks e a senha inicial.
2. Clique em **Gerenciar workspaces → Novo workspace** e informe o nome do cliente.
3. Em **Gerenciar**, informe o e-mail da pessoa e escolha sua permissão.
4. Clique em **Gerar convite**, copie o link exibido e compartilhe com o destinatário. Não há envio automático de e-mail.
5. O convidado cria nome e senha; se já possui conta, confirma a senha existente para adicionar o novo workspace ao mesmo login.
6. Alterne entre clientes pelo seletor de workspace. No celular e no modo incorporado, o seletor fica na barra superior.

| Perfil | Acesso |
| --- | --- |
| Administrador Folks | Todos os workspaces, criação de clientes, equipe e automações. |
| Administrador | Apenas workspaces associados; eventos, automações, equipe e integração. |
| Editor | Consulta, criação, edição e exclusão de eventos nos workspaces associados. |
| Somente leitura | Consulta aos eventos dos workspaces associados. Sem acesso a segredos, webhooks, histórico ou membros. |

A permissão é consultada no banco a cada requisição. Remover um membro bloqueia imediatamente novas chamadas à API daquele workspace, inclusive em sessões existentes. A interface verifica a conta a cada 15 segundos. Alterar o perfil ou remover um administrador revoga seus convites pendentes naquele workspace. Membros não podem alterar o próprio perfil nem o administrador Folks. O administrador global não é concedido por convite.

Convites são vinculados ao e-mail, guardados apenas como hash e usados uma única vez. Gerar outro convite para o mesmo e-mail revoga o anterior. O link usa fragmento (`#invite=...`) para não aparecer em logs de acesso HTTP. Trate o link como credencial e compartilhe apenas com o destinatário. Não há verificação de e-mail por mensagem nem recuperação automática de senha nesta versão. Uma pessoa pode pertencer a vários clientes com permissões diferentes.

## Migração da agenda existente

A versão com workspaces migra automaticamente o banco legado no primeiro boot:

- Cria um backup SQLite consistente `backup-before-workspaces-TIMESTAMP.sqlite` no diretório de dados antes de alterar o schema.
- Cria o workspace **Folks** e associa a ele eventos, configurações de webhook, fila e histórico existentes, preservando IDs e segredos.
- Mantém os registros de lembretes já disparados para não reenviá-los devido à migração.
- Cria uma conta de administrador global com `ADMIN_EMAIL` e a senha de `APP_PASSWORD`.
- Invalida o antigo formato de sessão compartilhada. Todos precisam entrar novamente, agora com e-mail e senha.

A migração é transacional e executada uma única vez (`PRAGMA user_version=2`). Nas inicializações seguintes, mudar `APP_PASSWORD` ou `ADMIN_EMAIL` não altera contas existentes. `SESSION_SECRET` não é mais utilizado: as novas sessões usam tokens aleatórios e hashes persistidos no banco. Faça rollback restaurando o backup junto com a versão anterior da aplicação; o servidor antigo não deve rodar sobre o banco migrado.

## Incorporar no HELENA

1. Publique a aplicação em um domínio HTTPS.
2. Abra **Gerenciar workspaces → Gerenciar → Identidade e integração** no cliente desejado.
3. Em **Origens autorizadas do HELENA**, informe a origem exata da página que incorpora a agenda, por exemplo `https://crm.sua-empresa.com`, sem caminhos, e salve.
4. Copie o **Link para incorporar**, no formato `https://seu-dominio.com/?workspace=ID&embed=1`.
5. Cadastre esse link na integração de sites externos do HELENA.
6. Cada pessoa entra com e-mail e senha próprios. O link não concede acesso e um usuário sem permissão não pode abrir o workspace. O login não depende de cookies de terceiros.

```html
<iframe src="https://seu-dominio.com/?workspace=ID&embed=1"
        title="Folks Calendar" width="100%" height="900"
        style="border:0" allow="clipboard-write"></iframe>
```

A integração dentro da conta HELENA precisa ser validada no ambiente real. Além da página incorporável e dos webhooks genéricos, esta aplicação envia modelos aprovados diretamente pela API do HELENA, sem intermediário. Configure a conexão em Automações → Mensagens pelo HELENA. Não há sincronização automática com eventos nativos do CRM.

## Webhooks

Selecione o workspace do cliente. Cadastre em **Automações → Nova automação** o nome, a URL HTTPS pública (porta 443) e os gatilhos:

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

Pausar uma automação cancela seus envios pendentes imediatamente; reativar não reproduz disparos antigos. Excluir a automação cancela a fila pendente. Uma chamada que já começou pode terminar mesmo após pausa ou exclusão.

Exemplo de payload:

```json
{
  "id": "uuid-da-entrega",
  "type": "event.created",
  "workspaceId": "uuid-do-workspace",
  "createdAt": "2026-09-13T18:00:00.000Z",
  "source": "folks-calendar",
  "data": {
    "id": "uuid-do-evento",
    "workspaceId": "uuid-do-workspace",
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

O worker consulta somente os webhooks do mesmo workspace do evento; testes, lembretes, reenvios e histórico mantêm esse vínculo. Cada automação tem um segredo gerado pelo servidor, disponível em **Configurar → Copiar segredo**. O header `X-Folks-Signature` contém `t=TIMESTAMP,v1=ASSINATURA`, sendo a assinatura HMAC-SHA256 hexadecimal de `TIMESTAMP.CORPO_JSON_ORIGINAL`. Valide sobre os bytes originais do corpo com comparação em tempo constante e rejeite timestamps muito antigos (por exemplo, mais de 5 minutos). `X-Folks-Delivery` é igual ao `id` do payload.

O receptor deve deduplicar pelo ID da entrega: se a resposta se perder depois de processar o evento, haverá reenvio com o mesmo ID. As entregas não garantem ordem entre si.

## Testes

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Os testes de API verificam autenticação, validação, bloqueio de destinos privados, persistência, CRUD, fila, cancelamento, disparos agendados, migração legada, isolamento entre clientes, tentativas de acessar IDs alheios, perfis, convites, revogação e reinicialização. O teste de navegador cobre login, criação/edição/exclusão, persistência após recarga, três visualizações, busca, cadastro/pausa de automação e modo incorporado no celular. Também testa criação de cliente, convite, acesso somente leitura, troca de perfil, remoção de acesso e incorporação de um workspace. Usa banco separado em `test-results/`.

Referências técnicas: [Vite](https://vite.dev/guide/) e [SQLite no Node.js](https://nodejs.org/api/sqlite.html).


## Mensagens diretas pelo HELENA

Em **Automações → Mensagens pelo HELENA**, conecte o token **da conta** (Ajustes → Integrações no HELENA). O servidor consulta canais oficiais ativos e modelos aprovados. Cada workspace tem sua própria conexão; o token permanece no banco da VPS, protegido pelas permissões do volume, e não é retornado ao navegador nem incluído nos registros de envio. Backups contêm a credencial e devem manter acesso restrito.

Crie uma regra, escolha canal, modelo, destinatário (cliente ou responsável), gatilhos e agenda. Mapeie as variáveis do modelo para textos fixos ou `{{nome}}`, `{{responsavel}}`, `{{titulo}}`, `{{data}}`, `{{hora}}`, `{{fim}}`, `{{local}}`, `{{descricao}}`, `{{email}}`, `{{contato}}`, `{{telefone}}`. Datas/horários usam o fuso escolhido na regra. Modelos com mídia exigem URL HTTPS ou ID do arquivo. A aprovação e o conteúdo dos modelos continuam sendo gerenciados no HELENA.

Preencha o nome e o WhatsApp com código do país e DDD no evento. O campo Contato/ID no CRM continua disponível, mas o destino das mensagens é o campo WhatsApp. Desmarque **Permitir mensagens automáticas neste evento** para suprimir os envios. Todos os eventos da agenda selecionada participam das regras ativas; não há escolha de um modelo individual por evento.

Cada regra de lembrete tem sua própria antecedência (5, 15, 30, 60, 120 ou 1440 minutos), permitindo avisos de 24h e 2h para o mesmo compromisso. O seletor de lembrete por webhook no evento continua controlando somente webhooks genéricos. Lembretes HELENA vencidos antes da ativação da regra não são enviados. Após interrupções, a tolerância é de uma hora e lembretes nunca são enviados após o início do evento. Alterar o início rearma os gatilhos; editar texto não rearma. Pausar, excluir ou editar uma regra cancela seus envios pendentes; reativar não reproduz envios antigos.

O histórico mostra **Aceito pelo HELENA** quando a API aceita o envio. Use **Consultar entrega** para atualizar o status no provedor. Aceitação não significa entrega no WhatsApp. Falhas definitivas não são repetidas; HTTP 429 permite até cinco tentativas. Timeout, HTTP 5xx ou interrupção durante envio ficam em **Conferir no HELENA**, sem reenvio automático, pois a API não documenta uma garantia de idempotência para `senderId`. Esse campo recebe o ID da entrega para rastreamento. Webhooks genéricos mantêm a política de cinco tentativas.

Trocar/desconectar o token pausa as regras HELENA e cancela pendências. Revise o canal e o modelo antes de reativar; isso evita usar dados de uma conta em outra. Envios já iniciados podem terminar. A migração para schema 3 cria backup antes de adicionar conexões e informações de envio, preservando usuários, workspaces, eventos e webhooks existentes.

Referências: [autenticação](https://flwchat.readme.io/reference/getting-started-with-your-api), [modelos](https://flwchat.readme.io/reference/get_v1-template), [envio de template](https://flwchat.readme.io/reference/post_v1-send-template), [consulta de envio](https://flwchat.readme.io/reference/get_v1-send-message-id). Origem da API: `https://api.wts.chat/chat/v1/`.

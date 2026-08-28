# Rewind Chat

Extensão de navegador (Chrome, Manifest V3) desenvolvida como ferramenta interna para agilizar o atendimento ao suporte no **Freshchat**.

A extensão lê a conversa diretamente da tela do Freshchat e gera **resumos automáticos do atendimento** — em nível breve, normal ou detalhado — usando a API Gemini (Google Generative Language API).

##  Funcionalidades

- Leitura automática do conteúdo da conversa exibida na tela do Freshchat/Freshworks CRM.
- Geração de resumos em três níveis de detalhamento:
  - **Breve** — visão rápida do atendimento.
  - **Normal** — resumo equilibrado com os pontos principais.
  - **Detalhado** — cobertura completa da conversa.
- Integração com a API do Google Gemini para geração dos resumos.
- Interface leve, injetada diretamente na página do Freshchat (via content script).

##  Tecnologias

- **Manifest V3** (extensão de navegador)
- JavaScript e Node.js 20+ (build sem dependências externas)
- CSS (estilização do conteúdo injetado)
- API Gemini — `generativelanguage.googleapis.com`

##  Estrutura do projeto

```
rewind-chat/
├── src/
│   ├── common/                 # Código e recursos compartilhados
│   ├── manifests/              # Manifestos de Chromium e Firefox
│   └── platforms/              # Sobrescritas específicas por navegador
├── scripts/                    # Build, validação e limpeza
├── dist/                       # Pacotes gerados (não versionados)
└── package.json
```

## Desenvolvimento

Requer Node.js 20 ou superior. Não há dependências externas.

```powershell
npm run check
npm run build
```

Também é possível gerar apenas um navegador com `npm run build:chromium` ou
`npm run build:firefox`.

##  Permissões

| Permissão | Motivo |
|---|---|
| `storage` | Armazenamento local de configurações/chave de API |
| `https://generativelanguage.googleapis.com/*` | Chamadas à API do Gemini para gerar os resumos |
| `https://*.freshchat.com/*` e `https://*.myfreshworks.com/*` | Leitura da conversa na interface do Freshchat/Freshworks |

O content script é executado apenas em páginas que correspondem a:
```
https://*.myfreshworks.com/crm/messaging/*
```

##  Instalação (modo desenvolvedor)

1. Clone este repositório:
   ```bash
   git clone https://github.com/kaualucs/rewind-chat.git
   ```
2. Abra o Chrome (ou navegador baseado em Chromium) e acesse `chrome://extensions`.
3. Ative o **Modo do desenvolvedor** no canto superior direito.
4. Execute `npm run build:chromium`.
5. Clique em **Carregar sem compactação** e selecione `dist/chromium`.
6. Acesse o Freshchat/Freshworks CRM normalmente — a extensão será ativada automaticamente na tela de atendimento.

No Firefox, execute `npm run build:firefox` e carregue
`dist/firefox/manifest.json` em `about:debugging#/runtime/this-firefox`.

##  Configuração

A extensão depende de uma chave de API do **Google Gemini** para gerar os resumos. Configure a chave conforme indicado na interface da extensão (armazenada via `chrome.storage`).

##  Sobre

Ferramenta interna desenvolvida pela **Next Fit** para uso da equipe de suporte, com o objetivo de reduzir o tempo gasto na elaboração manual de resumos de atendimento.

**Versão atual:** 1.2.0

## 📄 Licença

Não especificada. Adicione um arquivo `LICENSE` caso deseje tornar os termos de uso explícitos.

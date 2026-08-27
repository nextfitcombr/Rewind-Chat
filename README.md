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
- JavaScript (background service worker + content script)
- CSS (estilização do conteúdo injetado)
- API Gemini — `generativelanguage.googleapis.com`

##  Estrutura do projeto

```
rewind-chat/
├── manifest.json      # Configuração da extensão (Manifest V3)
├── background.js      # Service worker
├── content.js          # Script injetado nas páginas do Freshchat
├── content.css          # Estilos do conteúdo injetado
├── icons/                 # Ícones da extensão (16, 48, 128px)
└── .gitignore
```

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
4. Clique em **Carregar sem compactação** e selecione a pasta do repositório clonado.
5. Acesse o Freshchat/Freshworks CRM normalmente — a extensão será ativada automaticamente na tela de atendimento.

##  Configuração

A extensão depende de uma chave de API do **Google Gemini** para gerar os resumos. Configure a chave conforme indicado na interface da extensão (armazenada via `chrome.storage`).

##  Sobre

Ferramenta interna desenvolvida pela **Next Fit** para uso da equipe de suporte, com o objetivo de reduzir o tempo gasto na elaboração manual de resumos de atendimento.

**Versão atual:** 1.2.0

## 📄 Licença

Não especificada. Adicione um arquivo `LICENSE` caso deseje tornar os termos de uso explícitos.

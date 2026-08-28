(function () {
  "use strict";

  // O Firefox expõe as APIs em `browser.*` retornando promise; o `chrome.*`
  // dele é a camada de compatibilidade baseada em callback. Como este código
  // usa promise (`await ...storage.local.get()`), preferimos `browser` quando
  // ele existe. No Chrome/Brave `browser` é undefined e nada muda.
  //
  // Usa nome próprio em vez de redeclarar `chrome`: `const chrome` no escopo
  // global lançaria SyntaxError se `chrome` for propriedade não-configurável.
  const api = globalThis.browser || globalThis.chrome;

  const SELECTORS = {
    messageItem: "li.user-messages",
    agentMessage: ".fc-agent-message",
    userMessage: ".user-message",
  };

  const CONTEXTO = `Você é um assistente especializado em SUPORTE TÉCNICO de um sistema de gestão para academias (NextFit). Abaixo está a transcrição completa de um atendimento, lida diretamente da tela do agente no Freshchat. As mensagens estão em ordem cronológica, identificadas por "Cliente:", "Agente:" ou "Sistema:".

Seu trabalho é ajudar um atendente que vai assumir ou revisar esse atendimento a entender rapidamente o que foi conversado. Baseie-se SOMENTE no conteúdo da transcrição — não invente informações que não estão presentes.

NÃO inclua informações que o atendente já tem disponíveis em outro lugar, como: canal/plataforma do atendimento, nome do cliente que abriu o contato, nome do agente, ou qualquer dado de sistema/metadado. O foco é o CONTEÚDO do que foi discutido: qual módulo do sistema foi abordado, nome do aluno/dados informados pelo cliente (quando fizerem parte do problema relatado), dúvidas levantadas, respostas e soluções dadas.

Responda em português do Brasil, de forma clara e objetiva. Não use saudações nem despedidas, vá direto ao resumo.`;

  const PROMPTS = {
    breve: `TIPO DE RESUMO: BREVE
Em tópicos curtos, para o atendente bater o olho e entender na hora. Use exatamente esta estrutura:
- **Dor do cliente:** qual o problema/necessidade relatado (inclua módulo do sistema e dados relevantes, ex: nome do aluno, se citados).
- **O que foi abordado:** o que já foi discutido, verificado ou orientado até agora.
- **O que falta resolver:** pendência, status atual ou próximo passo.
Frases curtas e diretas, sem floreios. No máximo ~15 palavras por tópico.`,

    normal: `TIPO DE RESUMO: NORMAL
Resumo objetivo do atendimento, informando o necessário para quem for continuar o caso. Use exatamente esta estrutura:
- **Dor do cliente:** qual o problema/necessidade relatado, com módulo do sistema e dados relevantes (ex: nome do aluno) quando fizerem parte do relato.
- **O que foi abordado:** as principais dúvidas tratadas e as ações/orientações do agente durante o atendimento.
- **O que falta resolver:** pendências, status atual, próximos passos ou o que ainda está aguardando algo/alguém.
Um pouco mais de contexto que o resumo breve, mas sem repetir informação — frases completas e diretas.`,

    detalhado: `TIPO DE RESUMO: DETALHADO
O foco aqui é detalhar tudo o que foi discutido no atendimento, para outro atendente entender o caso a fundo sem reler a conversa inteira. Use exatamente esta estrutura:
- **Dor do cliente:** o problema/dúvida inicial, com módulo do sistema e dados relevantes (ex: nome do aluno) quando citados.
- **O que foi abordado:** cada dúvida ou ponto tratado na conversa, com detalhe do que foi perguntado, verificado e como foi respondido/orientado.
- **O que falta resolver:** o que ficou em aberto, sem solução, ou aguardando algo/alguém.
Traga o máximo de detalhe relevante sobre o CONTEÚDO conversado. Se algum tópico não tiver informação na conversa, escreva "Não informado".`,
  };

  const ROTULOS_TIPO = {
    breve: "Resumo breve",
    normal: "Resumo normal",
    detalhado: "Resumo detalhado",
  };

  let painelEl = null;
  let botaoEl = null;
  let tipoEmAndamento = null;
  let urlAtual = location.href;

  // Balão flutuante: só existe pra dar um status visual quando o painel
  // está minimizado durante uma geração (nada disso aparece com o painel
  // aberto — lá o status já é mostrado no próprio painel). Diferente do
  // resto do painel, o balão acompanha a geração pelo `urlGeracaoAcompanhada`
  // em vez da URL atual — assim ele continua visível mesmo se o agente
  // trocar de conversa enquanto o resumo está sendo gerado.
  let balaoEl = null;
  let balaoTimer = null;
  let estadoAtual = null; // null | "gerando" | "pronto" | "erro"
  let balaoUltimoEstadoMostrado = null;
  let urlGeracaoAcompanhada = null;

  // Bolinha vermelha no ícone injetado no Freshworks: fica ligada quando o
  // resumo da conversa ATUAL termina sem o agente ter visto (painel
  // minimizado), e some assim que o painel é aberto. Diferente do balão
  // (que acompanha a geração entre conversas), essa bolinha é sempre sobre
  // a conversa que está sendo exibida agora.
  let resumoPendente = false;

  function limparTexto(txt) {
    return (txt || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  function classificarAutor(item) {
    if (item.matches(SELECTORS.agentMessage) || item.querySelector(SELECTORS.agentMessage))
      return "Agente";
    if (item.matches(SELECTORS.userMessage) || item.querySelector(SELECTORS.userMessage))
      return "Cliente";
    return "Sistema";
  }

  function encontrarTextoMensagem(item) {
    const candidatos = item.querySelectorAll(
      "[class*='message-text'], [class*='conv-message'], [class*='msg-text'], p"
    );
    for (const c of candidatos) {
      const t = limparTexto(c.textContent);
      if (t) return t;
    }
    return limparTexto(item.textContent);
  }

  function encontrarUrlAudio(item) {
    const audioEl = item.querySelector("audio");
    if (!audioEl) return null;
    if (audioEl.currentSrc) return audioEl.currentSrc;
    if (audioEl.src) return audioEl.src;
    const source = audioEl.querySelector("source[src]");
    return source ? source.src : null;
  }

  function coletarMensagensPrimario() {
    const itens = document.querySelectorAll(SELECTORS.messageItem);
    const mensagens = [];
    itens.forEach((item) => {
      const autor = classificarAutor(item);
      const urlAudio = encontrarUrlAudio(item);
      if (urlAudio) {
        mensagens.push({ autor, tipo: "audio", url: urlAudio });
        return;
      }
      const texto = encontrarTextoMensagem(item);
      if (texto) mensagens.push({ autor, tipo: "texto", texto });
    });
    return mensagens;
  }

  function coletarMensagensFallback() {
    const candidatos = document.querySelectorAll("[class*='message']");
    const mensagens = [];
    const vistos = new Set();
    candidatos.forEach((el) => {
      if (el.children.length > 2 || vistos.has(el)) return;
      const urlAudio = encontrarUrlAudio(el);
      const texto = urlAudio ? "" : limparTexto(el.textContent);
      if (!urlAudio && !texto) return;
      vistos.add(el);
      const ehAgente = !!el.closest("[class*='agent']");
      const ehCliente = !ehAgente && el.closest("[class*='user'],[class*='customer'],[class*='contact']");
      const autor = ehAgente ? "Agente" : ehCliente ? "Cliente" : "Sistema";
      if (urlAudio) mensagens.push({ autor, tipo: "audio", url: urlAudio });
      else mensagens.push({ autor, tipo: "texto", texto });
    });
    return mensagens;
  }

  function coletarMensagens() {
    const primario = coletarMensagensPrimario();
    if (primario.length) return primario;
    return coletarMensagensFallback();
  }

  function encontrarContainerDeRolagem() {
    const item =
      document.querySelector(SELECTORS.messageItem) || document.querySelector("[class*='message']");
    if (!item) return null;
    let el = item.parentElement;
    while (el && el !== document.body) {
      const estilo = getComputedStyle(el);
      if (/(auto|scroll)/.test(estilo.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  }

  function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function chaveMensagem(m) {
    return m.tipo === "audio" ? `${m.autor}::audio::${m.url}` : `${m.autor}::${m.texto}`;
  }

  function mesclarMensagens(existentes, novasMsgs) {
    const contagemExistentes = new Map();
    existentes.forEach((m) => {
      const chave = chaveMensagem(m);
      contagemExistentes.set(chave, (contagemExistentes.get(chave) || 0) + 1);
    });

    const contagemNovas = new Map();
    const ineditas = [];
    novasMsgs.forEach((m) => {
      const chave = chaveMensagem(m);
      const antes = contagemExistentes.get(chave) || 0;
      const agora = (contagemNovas.get(chave) || 0) + 1;
      contagemNovas.set(chave, agora);
      if (agora > antes) ineditas.push(m);
    });

    return [...ineditas, ...existentes];
  }

  async function carregarConversaCompleta() {
    let mensagens = coletarMensagens();
    const container = encontrarContainerDeRolagem();
    if (!container) return mensagens;

    let tentativasSemNovidade = 0;
    for (let i = 0; i < 25 && tentativasSemNovidade < 3; i++) {
      const totalAntes = mensagens.length;
      container.scrollTop = 0;
      await esperar(450);
      mensagens = mesclarMensagens(mensagens, coletarMensagens());
      if (mensagens.length === totalAntes) tentativasSemNovidade++;
      else tentativasSemNovidade = 0;
    }
    return mensagens;
  }

  function montarPartesPrompt(tipo, mensagens) {
    const partes = [];
    let bufferTexto = `${CONTEXTO}\n\n${PROMPTS[tipo]}\n\n=== TRANSCRIÇÃO DO ATENDIMENTO ===\n`;

    mensagens.forEach((m) => {
      if (m.tipo === "audio") {
        bufferTexto += `${m.autor} (mensagem de áudio a seguir — ouça e leve o conteúdo em conta no resumo):\n`;
        partes.push({ text: bufferTexto });
        partes.push({ audioUrl: m.url });
        bufferTexto = "\n";
      } else {
        bufferTexto += `${m.autor}: ${m.texto}\n`;
      }
    });

    bufferTexto += "=== FIM DA TRANSCRIÇÃO ===";
    partes.push({ text: bufferTexto });
    return partes;
  }

  function escaparHtml(texto) {
    return (texto || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatarSaida(texto) {
    return escaparHtml(texto)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");
  }

  /* ========================================================================
     Renderização do resumo como lista de itens com ícone (um por tópico
     "- **Rótulo:** texto" que a IA devolve), com fallback para texto puro
     caso a resposta não siga esse formato.
     ======================================================================== */
  const ICONES_ITEM = {
    dor: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8Z"></path>',
    abordado: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"></path><polyline points="22 4 12 14.1 8.5 10.6"></polyline>',
    faltaResolver: '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 6.5 12 12 16 14.2"></polyline>',
    info: '<circle cx="12" cy="12" r="9.5"></circle><line x1="12" y1="16" x2="12" y2="11.3"></line><line x1="12" y1="7.7" x2="12.01" y2="7.7"></line>',
  };

  function iconeParaRotulo(rotulo) {
    const r = rotulo.toLowerCase();
    if (r.includes("dor") || r.includes("motivo")) return { svg: ICONES_ITEM.dor, variante: "rosa" };
    if (r.includes("falta resolver") || r.includes("pendênc")) return { svg: ICONES_ITEM.faltaResolver, variante: "ambar" };
    if (
      r.includes("abordado") ||
      r.includes("feito") ||
      r.includes("assuntos") ||
      r.includes("resolvido") ||
      r.includes("orientado") ||
      r.includes("tom do")
    ) {
      return { svg: ICONES_ITEM.abordado, variante: "roxo" };
    }
    return { svg: ICONES_ITEM.info, variante: "roxo" };
  }

  function analisarItens(texto) {
    const linhas = texto.split("\n");
    const itens = [];
    linhas.forEach((linha) => {
      const m = linha.match(/^[-*]\s*\*\*(.+?)\*\*:?\s*(.*)$/);
      if (m) {
        itens.push({ rotulo: m[1].trim(), texto: m[2].trim() });
      } else if (itens.length && linha.trim()) {
        itens[itens.length - 1].texto += ` ${linha.trim()}`;
      }
    });
    return itens;
  }

  function renderizarResumo(texto) {
    const container = painelEl.querySelector("#rwc-result-text");
    const itens = analisarItens(texto);
    if (!itens.length) {
      container.innerHTML = `<div class="rwc-result-plain">${formatarSaida(texto)}</div>`;
      return;
    }
    container.innerHTML = itens
      .map((item, i) => {
        const { svg, variante } = iconeParaRotulo(item.rotulo);
        const divisor = i < itens.length - 1 ? '<div class="rwc-item-divider"></div>' : "";
        return `
          <div class="rwc-item">
            <span class="rwc-item-icon rwc-item-icon--${variante}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>
            </span>
            <div class="rwc-item-body"><strong>${escaparHtml(item.rotulo)}:</strong> ${formatarSaida(item.texto)}</div>
          </div>
          ${divisor}
        `;
      })
      .join("");
  }

  /* ========================================================================
     Estado do resumo em background — sobrevive ao fechamento da aba.
     Depois que a leitura da tela termina e as partes são enviadas para o
     background.js, a geração continua rodando lá independentemente desta
     aba estar aberta. O resultado (ou erro) fica salvo em storage; aqui só
     refletimos esse estado quando ele pertence à conversa atual.
     ======================================================================== */
  function gerarSolicitacaoId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Precisa casar com idDaConversa() do background.js. A comparação era por
  // `location.href` exato, então bastava o Freshworks mexer na query string
  // sozinho pra o resumo já pronto virar "de outra conversa" e nunca mais
  // aparecer — mesmo com a notificação de "pronto" já tendo disparado.
  function idDaConversa(href) {
    try {
      const u = new URL(href);
      return `${u.origin}${u.pathname}${u.hash}`.replace(/\/+$/, "");
    } catch (_) {
      return href || "";
    }
  }

  function pertenceAConversaAtual(dados) {
    return !!dados && idDaConversa(dados.url) === idDaConversa(location.href);
  }

  async function lerResumoDaConversa(href) {
    const { rwcResumos } = await api.storage.local.get("rwcResumos");
    return (rwcResumos || {})[idDaConversa(href)] || null;
  }

  // Se o background morrer no meio da geração (ex: service worker
  // encerrado pelo Chrome), o storage fica travado em "gerando" para
  // sempre. O background atualiza `atualizadoEm` a cada ~15s enquanto está
  // vivo (heartbeat), então esse tempo mede "sem sinal de vida", não
  // "desde o início" — por isso pode ficar folgado sem risco de interromper
  // uma geração longa (vários áudios + retries) que ainda está rodando.
  //
  // Folgado o bastante pra dar tempo do alarme de retomada do background
  // (que roda a cada 1 min e considera órfão quem passou 60s sem heartbeat)
  // ressuscitar o trabalho. Desistir antes disso mostraria um erro em cima
  // de uma geração que está justamente sendo recuperada.
  const GERANDO_TIMEOUT_MS = 240000;

  function exibirResumo(dados, opcoes) {
    if (!dados) return;
    if (!pertenceAConversaAtual(dados)) return;
    const forcarSelecao = !!(opcoes && opcoes.forcarSelecao);
    if (!forcarSelecao && dados.tipo !== tipoEmAndamento) return;

    if (forcarSelecao) {
      abrirPainel();
      tipoEmAndamento = dados.tipo;
      marcarTipoAtivo(dados.tipo);
    }
    if (!painelEl) return;

    painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
    esconderStatus();

    if (dados.status === "gerando" && Date.now() - (dados.atualizadoEm || 0) > GERANDO_TIMEOUT_MS) {
      definirCarregando(false);
      mostrarStatus("error", "A geração anterior não terminou (a extensão pode ter sido reiniciada). Tente novamente.");
    } else if (dados.status === "gerando") {
      definirCarregando(true);
      mostrarStatus("gerando");
      // Garante que o balão passe a acompanhar esta geração mesmo quando ela
      // não foi iniciada por esta função (ex: painel forçado a abrir ao
      // carregar a página com uma geração já em andamento nesta conversa).
      urlGeracaoAcompanhada = dados.url;
      atualizarBalaoDaGeracaoAcompanhada(dados);
    } else if (dados.status === "pronto") {
      definirCarregando(false);
      painelEl.querySelector("#rwc-result-tag").textContent = ROTULOS_TIPO[dados.tipo] || "Resumo";
      renderizarResumo(dados.texto);
      painelEl.querySelector("#rwc-result").dataset.raw = dados.texto;
      painelEl.querySelector("#rwc-result").classList.remove("rwc-hidden");
      // Painel minimizado quando terminou: o agente ainda não viu o
      // resultado, marca a bolinha de pendente no ícone do Freshworks.
      resumoPendente = !painelEl.classList.contains("rwc-panel--open");
      atualizarIndicadorPendente();
    } else if (dados.status === "erro") {
      definirCarregando(false);
      mostrarStatus("error", dados.erro || "Ocorreu um erro inesperado.");
    }
  }

  // Ao contrário de exibirResumo (que só reage se a atualização pertencer à
  // conversa ATUAL), o balão acompanha a geração que esta aba iniciou pela
  // URL guardada em urlGeracaoAcompanhada — assim ele continua aparecendo
  // e reagindo (pontinhos → check/erro) mesmo depois de o agente trocar de
  // contato/conversa.
  function atualizarBalaoDaGeracaoAcompanhada(dados) {
    if (
      !dados ||
      !urlGeracaoAcompanhada ||
      idDaConversa(dados.url) !== idDaConversa(urlGeracaoAcompanhada)
    ) {
      return;
    }

    if (dados.status === "gerando" && Date.now() - (dados.atualizadoEm || 0) > GERANDO_TIMEOUT_MS) {
      estadoAtual = "erro";
    } else if (dados.status === "gerando") {
      estadoAtual = "gerando";
    } else if (dados.status === "pronto") {
      estadoAtual = "pronto";
    } else if (dados.status === "erro") {
      estadoAtual = "erro";
    } else {
      return;
    }
    atualizarBalao();
  }

  // Se a extensão for recarregada (chrome://extensions) com esta aba já
  // aberta, o content script antigo fica órfão: api.runtime.id vira
  // undefined e qualquer chamada a api.storage/api.runtime rejeita
  // com "Extension context invalidated". Não tem como recuperar a aba sem
  // um F5 nela, então só evitamos deixar essas chamadas sem tratamento.
  function extensaoValida() {
    return !!(api.runtime && api.runtime.id);
  }

  async function restaurarUltimoResumoSeCorresponder() {
    if (!extensaoValida()) return;
    try {
      const dados = await lerResumoDaConversa(location.href);
      if (pertenceAConversaAtual(dados)) {
        exibirResumo(dados, { forcarSelecao: true });
      }
    } catch (_) {
      /* contexto da extensão invalidado — ignora */
    }
  }

  api.storage.onChanged.addListener((mudancas, area) => {
    if (area !== "local" || !mudancas.rwcResumos) return;
    const mapa = mudancas.rwcResumos.newValue || {};
    // O balão segue a conversa que ESTA aba mandou gerar; o painel segue a
    // conversa aberta agora. Podem ser diferentes se o agente trocou de tela
    // no meio da geração, então cada um lê a sua própria entrada.
    if (urlGeracaoAcompanhada) {
      atualizarBalaoDaGeracaoAcompanhada(mapa[idDaConversa(urlGeracaoAcompanhada)]);
    }
    exibirResumo(mapa[idDaConversa(location.href)]);
  });

  function criarPainel() {
    const painel = document.createElement("div");
    painel.id = "rwc-panel";
    painel.innerHTML = `
      <div class="rwc-header">
        <div class="rwc-brand">
          <span class="rwc-brand-copy">
            <span class="rwc-brand-name-purple">Rewind</span>
            <span class="rwc-brand-name-gray">Chat</span>
          </span>
          <span class="rwc-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 40" fill="#fff">
              <path d="M22 6 8 20 22 34Z"></path>
              <path d="M40 6 26 20 40 34Z"></path>
            </svg>
          </span>
        </div>
        <div class="rwc-header-actions">
          <button type="button" class="rwc-icon-btn" id="rwc-settings-toggle" title="Configurações" aria-label="Configurações">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <button type="button" class="rwc-icon-btn" id="rwc-minimize" title="Minimizar" aria-label="Minimizar">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button type="button" class="rwc-icon-btn" id="rwc-reset" title="Fechar e limpar resumo" aria-label="Fechar e limpar resumo">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>

      <div class="rwc-settings rwc-hidden" id="rwc-settings">
        <label class="rwc-field-label" for="rwc-gemini-key">Chave da API do Gemini</label>
        <input type="text" id="rwc-gemini-key" class="rwc-input rwc-input--secreto" placeholder="Cole sua chave aqui" autocomplete="off" spellcheck="false" />
        <button type="button" class="rwc-btn-primary" id="rwc-save-key">Salvar</button>
        <span class="rwc-settings-status rwc-hidden" id="rwc-settings-status"></span>
      </div>

      <div class="rwc-body">
        <span class="rwc-field-label">Tipo de resumo</span>
        <div class="rwc-segmented" id="rwc-type-selector" role="tablist">
          <button type="button" class="rwc-seg-btn" data-type="breve" role="tab">
            <span class="rwc-seg-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg></span>
            <span class="rwc-seg-label">Breve</span>
          </button>
          <button type="button" class="rwc-seg-btn" data-type="normal" role="tab">
            <span class="rwc-seg-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.2" fill="currentColor"></circle></svg></span>
            <span class="rwc-seg-label">Normal</span>
          </button>
          <button type="button" class="rwc-seg-btn" data-type="detalhado" role="tab">
            <span class="rwc-seg-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg></span>
            <span class="rwc-seg-label">Detalhado</span>
          </button>
        </div>

        <div id="rwc-status" class="rwc-status rwc-hidden"></div>

        <section id="rwc-result" class="rwc-result rwc-hidden">
          <div class="rwc-result-header">
            <span id="rwc-result-tag" class="rwc-result-tag">Resumo</span>
            <button type="button" class="rwc-copy-btn" id="rwc-copy">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>Copiar</span>
            </button>
          </div>
          <div id="rwc-result-text" class="rwc-result-text"></div>
        </section>
      </div>

      <div class="rwc-footer">
        <svg class="rwc-footer-wave" viewBox="0 0 380 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="rwcWaveSoft" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#f3edff"></stop>
              <stop offset="0.5" stop-color="#e7dcff"></stop>
              <stop offset="1" stop-color="#f5efff"></stop>
            </linearGradient>
            <linearGradient id="rwcWaveLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#b58cff"></stop>
              <stop offset="0.5" stop-color="#7c3aed"></stop>
              <stop offset="1" stop-color="#b58cff"></stop>
            </linearGradient>
          </defs>
          <path d="M0 54 C48 22 88 22 137 52 C186 82 227 84 274 55 C319 27 348 27 380 45 L380 100 L0 100 Z" fill="url(#rwcWaveSoft)" opacity="0.82"></path>
          <path d="M0 54 C48 22 88 22 137 52 C186 82 227 84 274 55 C319 27 348 27 380 45" fill="none" stroke="url(#rwcWaveLine)" stroke-width="1.35" opacity="0.78"></path>
          <path d="M0 66 C45 42 82 40 126 63 C174 88 213 89 258 64 C302 39 339 38 380 58" fill="none" stroke="#a78bfa" stroke-width="1.05" opacity="0.42"></path>
          <path d="M0 43 C39 67 78 72 119 52 C162 31 203 29 245 51 C290 75 331 76 380 54" fill="none" stroke="#c4b5fd" stroke-width="0.9" opacity="0.5"></path>
          <circle cx="47" cy="67" r="2.2" fill="#7c3aed" opacity="0.65"></circle>
          <circle cx="325" cy="38" r="2" fill="#8b5cf6" opacity="0.45"></circle>
        </svg>
        <div class="rwc-footer-caption">
          <span class="rwc-footer-line"></span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4L12 2Z"></path></svg>
          <span>criado por Kauã</span>
          <span class="rwc-footer-line"></span>
        </div>
      </div>
    `;
    document.body.appendChild(painel);

    painel.querySelector("#rwc-minimize").addEventListener("click", fecharPainel);
    painel.querySelector("#rwc-reset").addEventListener("click", resetarPainel);
    painel.querySelector("#rwc-settings-toggle").addEventListener("click", alternarConfiguracoes);
    painel.querySelector("#rwc-save-key").addEventListener("click", salvarChave);
    painel.querySelector("#rwc-copy").addEventListener("click", copiarResultado);
    painel.querySelector("#rwc-type-selector").addEventListener("click", (e) => {
      const btn = e.target.closest(".rwc-seg-btn");
      if (!btn || btn.disabled) return;
      gerarResumo(btn.dataset.type);
    });

    return painel;
  }

  function garantirPainel() {
    if (!painelEl) painelEl = criarPainel();
    return painelEl;
  }

  function criarBalao() {
    const balao = document.createElement("button");
    balao.type = "button";
    balao.id = "rwc-bubble";
    balao.className = "rwc-bubble rwc-hidden";
    balao.title = "Rewind Chat";
    balao.setAttribute("aria-label", "Rewind Chat — status do resumo");
    balao.innerHTML = `
      <span class="rwc-bubble-dots"><span></span><span></span><span></span></span>
      <svg class="rwc-bubble-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
      <svg class="rwc-bubble-erro" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="7.5" x2="12" y2="13"></line><line x1="12" y1="16.5" x2="12.01" y2="16.5"></line></svg>
    `;
    balao.addEventListener("click", () => {
      // Se o resumo acompanhado pelo balão for de outra conversa (o agente
      // trocou de tela enquanto gerava), volta pra ela em vez de abrir um
      // painel vazio na conversa atual.
      if (urlGeracaoAcompanhada && urlGeracaoAcompanhada !== location.href) {
        location.href = urlGeracaoAcompanhada;
        return;
      }
      abrirPainel();
    });
    document.body.appendChild(balao);
    return balao;
  }

  function garantirBalao() {
    if (!balaoEl || !balaoEl.isConnected) balaoEl = criarBalao();
    return balaoEl;
  }

  function esconderBalao() {
    if (balaoTimer) {
      clearTimeout(balaoTimer);
      balaoTimer = null;
    }
    if (balaoEl) {
      balaoEl.classList.add("rwc-hidden");
      balaoEl.classList.remove("rwc-bubble--carregando", "rwc-bubble--sucesso", "rwc-bubble--erro");
    }
  }

  // O balão só aparece com o painel minimizado (com o painel aberto o
  // status já é mostrado nele). Enquanto "gerando" fica com os pontinhos;
  // ao terminar (pronto/erro) troca o ícone uma única vez e some sozinho
  // depois de alguns segundos.
  function atualizarBalao() {
    const painelAberto = !!(painelEl && painelEl.classList.contains("rwc-panel--open"));
    if (painelAberto || !estadoAtual) {
      esconderBalao();
      return;
    }

    const balao = garantirBalao();
    balao.classList.remove("rwc-hidden");

    if (estadoAtual === "gerando") {
      if (balaoTimer) {
        clearTimeout(balaoTimer);
        balaoTimer = null;
      }
      balao.classList.remove("rwc-bubble--sucesso", "rwc-bubble--erro");
      balao.classList.add("rwc-bubble--carregando");
      balaoUltimoEstadoMostrado = "gerando";
      return;
    }

    if (balaoUltimoEstadoMostrado === estadoAtual) return;
    balaoUltimoEstadoMostrado = estadoAtual;

    balao.classList.remove("rwc-bubble--carregando");
    balao.classList.toggle("rwc-bubble--sucesso", estadoAtual === "pronto");
    balao.classList.toggle("rwc-bubble--erro", estadoAtual === "erro");

    if (balaoTimer) clearTimeout(balaoTimer);
    balaoTimer = setTimeout(() => {
      estadoAtual = null;
      urlGeracaoAcompanhada = null;
      balaoTimer = null;
      esconderBalao();
    }, estadoAtual === "pronto" ? 2200 : 3200);
  }

  function abrirPainel() {
    const painel = garantirPainel();
    painel.classList.add("rwc-panel--open");
    inicializarConfiguracoes();
    atualizarBalao();
    resumoPendente = false;
    atualizarIndicadorPendente();
  }

  function fecharPainel() {
    if (painelEl) painelEl.classList.remove("rwc-panel--open");
    atualizarBalao();
  }

  // Diferente de minimizar (fecharPainel), o reset apaga o resumo salvo
  // desta conversa: ao voltar para ela depois, a extensão não deve reabrir
  // sozinha mostrando o resumo antigo — fica como se nada tivesse sido
  // gerado ainda.
  async function resetarPainel() {
    tipoEmAndamento = null;
    estadoAtual = null;
    urlGeracaoAcompanhada = null;
    resumoPendente = false;
    atualizarIndicadorPendente();
    fecharPainel();
    if (painelEl) {
      painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
      painelEl.querySelector("#rwc-result").dataset.raw = "";
      esconderStatus();
      painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => b.classList.remove("rwc-seg-btn--active"));
      definirCarregando(false);
    }
    if (!extensaoValida()) return;
    try {
      // Apaga só o resumo desta conversa — os das outras seguem guardados.
      const { rwcResumos } = await api.storage.local.get("rwcResumos");
      const mapa = { ...(rwcResumos || {}) };
      const chave = idDaConversa(location.href);
      if (mapa[chave]) {
        delete mapa[chave];
        await api.storage.local.set({ rwcResumos: mapa });
      }
    } catch (_) {
      /* contexto da extensão invalidado — ignora */
    }
  }

  function alternarPainel() {
    const painel = garantirPainel();
    if (painel.classList.contains("rwc-panel--open")) fecharPainel();
    else abrirPainel();
  }

  function alternarConfiguracoes() {
    painelEl.querySelector("#rwc-settings").classList.toggle("rwc-hidden");
  }

  async function inicializarConfiguracoes() {
    if (!extensaoValida()) {
      mostrarStatusConfig("A extensão foi atualizada. Recarregue esta página (F5) para continuar.", false);
      painelEl.querySelector("#rwc-settings").classList.remove("rwc-hidden");
      return;
    }
    const campo = painelEl.querySelector("#rwc-gemini-key");
    try {
      const { geminiKey } = await api.storage.local.get("geminiKey");
      if (geminiKey) {
        campo.value = geminiKey;
        return;
      }
    } catch (_) {
      return;
    }
    const resposta = await api.runtime
      .sendMessage({ type: "rwc-obter-config-inicial" })
      .catch(() => null);
    if (resposta && resposta.geminiKey) {
      campo.value = resposta.geminiKey;
    } else {
      painelEl.querySelector("#rwc-settings").classList.remove("rwc-hidden");
      mostrarStatusConfig("Cole sua chave da API do Gemini para começar.", false);
    }
  }

  function mostrarStatusConfig(msg, sucesso) {
    const el = painelEl.querySelector("#rwc-settings-status");
    el.textContent = msg;
    el.classList.remove("rwc-hidden");
    el.classList.toggle("rwc-settings-status--ok", !!sucesso);
  }

  async function salvarChave() {
    const campo = painelEl.querySelector("#rwc-gemini-key");
    const valor = campo.value.trim();
    if (!valor) return;
    try {
      await api.storage.local.set({ geminiKey: valor });
      mostrarStatusConfig("Chave salva!", true);
      setTimeout(() => painelEl.querySelector("#rwc-settings-status").classList.add("rwc-hidden"), 2000);
    } catch (_) {
      mostrarStatusConfig("A extensão foi atualizada. Recarregue esta página (F5) e tente de novo.", false);
    }
  }

  function mostrarStatus(tipo, mensagem) {
    const el = painelEl.querySelector("#rwc-status");
    el.className = `rwc-status rwc-status--${tipo}`;
    if (tipo === "loading") {
      el.innerHTML = `<span class="rwc-spinner"></span><span>${mensagem}</span>`;
    } else if (tipo === "gerando") {
      el.innerHTML = `Gerando resumo<span class="rwc-dots"></span>`;
    } else {
      el.textContent = mensagem;
    }
  }
  function esconderStatus() {
    painelEl.querySelector("#rwc-status").classList.add("rwc-hidden");
  }

  function marcarTipoAtivo(tipo) {
    painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => {
      b.classList.toggle("rwc-seg-btn--active", b.dataset.type === tipo);
    });
  }

  function definirCarregando(carregando) {
    painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => (b.disabled = carregando));
    if (botaoEl) botaoEl.classList.toggle("rwc-btn--loading", carregando);
  }

  async function gerarResumo(tipo) {
    abrirPainel();
    marcarTipoAtivo(tipo);
    tipoEmAndamento = tipo;
    painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
    esconderStatus();

    if (!extensaoValida()) {
      mostrarStatus("error", "A extensão foi atualizada. Recarregue esta página (F5) e tente de novo.");
      return;
    }

    let geminiKey;
    try {
      ({ geminiKey } = await api.storage.local.get("geminiKey"));
    } catch (_) {
      mostrarStatus("error", "A extensão foi atualizada. Recarregue esta página (F5) e tente de novo.");
      return;
    }
    if (!geminiKey) {
      painelEl.querySelector("#rwc-settings").classList.remove("rwc-hidden");
      mostrarStatus("error", "Configure a chave da API do Gemini primeiro.");
      return;
    }

    definirCarregando(true);
    estadoAtual = "gerando";
    urlGeracaoAcompanhada = location.href;
    balaoUltimoEstadoMostrado = "gerando";
    atualizarBalao();
    try {
      // A leitura rola a tela do próprio atendimento para coletar as
      // mensagens; trocar de contato/conversa agora interrompe a leitura,
      // então avisamos claramente o agente para não trocar de tela ainda.
      mostrarStatus("aviso", "Lendo a conversa da tela... Não troque de contato até a leitura terminar.");
      const mensagens = await carregarConversaCompleta();
      if (tipo !== tipoEmAndamento) return; // agente trocou de tipo enquanto lia a tela

      if (!mensagens.length) {
        throw new Error(
          "Nenhuma mensagem encontrada nesta tela. Abra um atendimento e tente novamente."
        );
      }
      const parts = montarPartesPrompt(tipo, mensagens);

      // Handoff: a partir daqui a geração roda inteira no background.js e
      // fica salva em storage. Fechar esta aba não interrompe mais nada —
      // se a aba/painel continuar aberto, o storage.onChanged acima atualiza
      // a tela; se não, o resultado fica pronto para quando reabrir a mesma
      // conversa (ou dispara uma notificação do sistema). A partir daqui já
      // é seguro trocar de tela/contato.
      api.runtime
        .sendMessage({
          type: "rwc-gerar-resumo",
          apiKey: geminiKey,
          parts,
          tipo,
          url: location.href,
          solicitacaoId: gerarSolicitacaoId(),
        })
        .catch(() => {
          /* aba pode fechar aqui sem problema — resultado chega via storage */
        });

      mostrarStatus("gerando");
    } catch (erro) {
      if (tipo !== tipoEmAndamento) return;
      mostrarStatus("error", erro.message || "Ocorreu um erro inesperado.");
      definirCarregando(false);
      estadoAtual = "erro";
      atualizarBalao();
    }
  }

  async function copiarResultado() {
    const resultSection = painelEl.querySelector("#rwc-result");
    const texto = resultSection.dataset.raw || painelEl.querySelector("#rwc-result-text").textContent;
    try {
      await navigator.clipboard.writeText(texto);
      const label = painelEl.querySelector("#rwc-copy span");
      const original = label.textContent;
      label.textContent = "Copiado!";
      setTimeout(() => (label.textContent = original), 1500);
    } catch (_) {
    }
  }

  const ICONE_RESUMO = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm1 7V3.5L20.5 9H15ZM8 13h8v1.5H8V13Zm0 4h6v1.5H8V17Z"/></svg>`;

  function criarBotaoInline() {
    const botao = document.createElement("button");
    botao.id = "rwc-launcher-button";
    botao.type = "button";
    botao.className = "rwc-inline-btn";
    botao.title = "Rewind Chat — gerar resumo do atendimento";
    botao.setAttribute("aria-label", "Gerar resumo do atendimento");
    botao.innerHTML = ICONE_RESUMO;
    const acionar = (e) => {
      e.preventDefault();
      e.stopPropagation();
      alternarPainel();
    };
    botao.addEventListener("click", acionar);
    botao.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") acionar(e);
    });
    return botao;
  }

  function encontrarPontoDeInsercao() {
    const porId = document.getElementById("fd-copy-ai-conversation");
    if (porId) return { referencia: porId, posicao: "afterend" };

    const menu = document.querySelector('[data-test-id="hamburger-menu"]');
    if (menu && menu.parentElement) {
      return { referencia: menu.parentElement, posicao: "beforebegin" };
    }

    return null;
  }

  // Se o Freshworks recriar a toolbar (ex: ao trocar de conversa), o botão
  // antigo pode ficar desconectado e um novo é criado do zero em
  // criarBotaoInline() — sem classe nenhuma. Sincroniza aqui pra garantir
  // que a bolinha nunca "some" só porque o elemento foi trocado.
  function atualizarIndicadorPendente() {
    if (botaoEl) botaoEl.classList.toggle("rwc-inline-btn--pendente", resumoPendente);
  }

  function posicionarBotao() {
    const ponto = encontrarPontoDeInsercao();
    if (!ponto) {
      if (botaoEl) botaoEl.style.display = "none";
      return;
    }

    if (!botaoEl || !botaoEl.isConnected) {
      botaoEl = criarBotaoInline();
      atualizarIndicadorPendente();
    }
    botaoEl.style.display = "inline-flex";

    const { referencia, posicao } = ponto;
    const estaNoLugar =
      posicao === "afterend"
        ? botaoEl.previousElementSibling === referencia
        : botaoEl.nextElementSibling === referencia;

    if (!estaNoLugar) {
      referencia.insertAdjacentElement(posicao, botaoEl);
    }
  }

  function verificarTrocaDeUrl() {
    if (location.href === urlAtual) return;
    urlAtual = location.href;
    tipoEmAndamento = null;
    // estadoAtual/urlGeracaoAcompanhada NÃO são resetados aqui de propósito:
    // se uma geração estiver em andamento, o balão flutuante deve continuar
    // acompanhando ela mesmo que o agente troque de contato/conversa. Já a
    // bolinha de pendente é sempre sobre a conversa atual, então some ao
    // trocar — se a nova conversa tiver um resumo pronto não visto, o
    // restaurarUltimoResumoSeCorresponder() abaixo cuida de mostrar.
    resumoPendente = false;
    atualizarIndicadorPendente();
    if (painelEl) {
      painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
      esconderStatus();
      painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => b.classList.remove("rwc-seg-btn--active"));
      // A geração antiga (se houver) virou responsabilidade só do background;
      // esta tela não deve ficar travada esperando por ela.
      definirCarregando(false);
    }
    if (estadoAtual === "gerando") {
      // Trocou de contato com uma geração rolando: minimiza sozinho em vez
      // de deixar o painel aberto "vazio" na conversa nova — o balão
      // flutuante assume o status até o resumo terminar.
      fecharPainel(); // já chama atualizarBalao()
    } else {
      atualizarBalao();
    }
    restaurarUltimoResumoSeCorresponder();
  }

  function iniciar() {
    posicionarBotao();
    restaurarUltimoResumoSeCorresponder();
    const intervalo = setInterval(() => {
      if (!extensaoValida()) {
        // Extensão foi recarregada com esta aba já aberta — este content
        // script ficou órfão, não tem mais nada útil a fazer sem um F5.
        clearInterval(intervalo);
        return;
      }
      verificarTrocaDeUrl();
      posicionarBotao();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();

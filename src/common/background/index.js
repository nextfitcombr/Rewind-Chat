"use strict";

// O Firefox expõe as APIs em `browser.*` retornando promise; o `chrome.*`
// dele é a camada de compatibilidade baseada em callback. Como este código
// usa promise (`await ...storage.local.get()`), preferimos `browser` quando
// ele existe. No Chrome/Brave `browser` é undefined e nada muda.
//
// Usa nome próprio em vez de redeclarar `chrome`: `const chrome` no escopo
// global lançaria SyntaxError se `chrome` for propriedade não-configurável.
const api = globalThis.browser || globalThis.chrome;

async function obterChaveSalva() {
  const { geminiKey } = await api.storage.local.get("geminiKey");
  return geminiKey || "";
}

async function semearChaveDoConfigLocal() {
  try {
    const resp = await fetch(api.runtime.getURL("config.local.js"));
    if (!resp.ok) return "";
    const texto = await resp.text();
    const match = texto.match(/iaKey\s*:\s*["']([^"']+)["']/);
    if (!match || !match[1]) return "";
    await api.storage.local.set({ geminiKey: match[1] });
    return match[1];
  } catch (_) {
    return "";
  }
}

function arrayBufferParaBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const TAMANHO_BLOCO = 0x8000;
  let binario = "";
  for (let i = 0; i < bytes.length; i += TAMANHO_BLOCO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TAMANHO_BLOCO));
  }
  return btoa(binario);
}

const MIME_TYPES_AUDIO_POR_EXTENSAO = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mp3",
  wav: "audio/wav",
  aac: "audio/aac",
  aiff: "audio/aiff",
  flac: "audio/flac",
  m4a: "audio/aac",
};

// O S3 costuma devolver content-type genérico (ex: application/ogg), que o
// Gemini rejeita. A extensão do arquivo na URL é mais confiável.
function mimeTypeDoAudio(url, contentType) {
  const extensao = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (MIME_TYPES_AUDIO_POR_EXTENSAO[extensao]) {
    return MIME_TYPES_AUDIO_POR_EXTENSAO[extensao];
  }
  if (contentType && contentType.startsWith("audio/")) return contentType;
  return "audio/ogg";
}

async function baixarAudioBase64(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const mimeType = mimeTypeDoAudio(url, resp.headers.get("content-type"));
  return { base64: arrayBufferParaBase64(buffer), mimeType };
}

async function resolverPartes(partes) {
  return Promise.all(
    (partes || []).map(async (parte) => {
      if (!parte.audioUrl) return parte;
      try {
        const { base64, mimeType } = await baixarAudioBase64(parte.audioUrl);
        return { inlineData: { mimeType, data: base64 } };
      } catch (erro) {
        return { text: "[Não foi possível baixar este áudio para transcrição]" };
      }
    })
  );
}

function aguardarMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 503 (modelo sobrecarregado) e 429 (limite de uso) costumam ser picos
// transitórios do lado do Gemini — tenta de novo com backoff em vez de
// obrigar o usuário a refazer a leitura da tela + download de áudio.
//
// Reduzimos pra 3 tentativas com teto de 8s (era 4 tentativas / 15s): no
// pior caso isso corta o tempo perdido em espera de ~29s pra ~10s. Ainda dá
// resiliência pra picos curtos sem deixar o agente esperando quase meio
// minuto só de backoff quando o modelo está sobrecarregado.
async function chamarGeminiComRetry(url, body, onTentativa, tentativas = 3) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp;

    const status = resp.status;
    const retentavel = status === 503 || status === 429 || status >= 500;
    if (!retentavel || tentativa === tentativas) {
      const corpo = await resp.text().catch(() => "");
      let dica = "";
      if (status === 400) dica = " (chave da API do Gemini inválida)";
      if (status === 429) dica = " (limite de uso da IA atingido, tente novamente em instantes)";
      if (status === 503) dica = " (modelo sobrecarregado no momento, tente novamente em instantes)";
      const falha = new Error(`A IA retornou ${status}${dica}. ${corpo}`);
      // Marca o erro como transitório: em vez de desistir e obrigar o agente
      // a refazer tudo, o chamador reagenda o trabalho (que já está guardado
      // com o tipo de resumo escolhido e a transcrição pronta).
      falha.retentavel = retentavel;
      throw falha;
    }

    // Jitter: a extensão roda em vários agentes ao mesmo tempo e um pico de
    // 503 atinge todos juntos. Sem isso, todos voltariam a bater na API no
    // mesmo instante e só prolongariam a sobrecarga.
    const espera = Math.min(2000 * 2 ** (tentativa - 1), 8000) + Math.floor(Math.random() * 1000);
    console.warn(`[rwc] Gemini retornou ${status}, tentando de novo em ${espera}ms (tentativa ${tentativa}/${tentativas})`);
    if (onTentativa) onTentativa(tentativa + 1, tentativas);
    await aguardarMs(espera);
  }
}

async function gerarResumoIA(apiKey, partes, onTentativa) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const partesResolvidas = await resolverPartes(partes);

  const resp = await chamarGeminiComRetry(
    url,
    {
      contents: [{ parts: partesResolvidas }],
      // 2048 tokens já cortava o resumo detalhado no meio (às vezes só
      // "Dor do cliente" saía completo): modelos mais novos gastam parte
      // desse limite com raciocínio interno antes de escrever a resposta
      // visível, sobrando pouco pro texto em si num resumo com bastante
      // conteúdo. 8192 dá folga de sobra pro texto sem custar muito mais.
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    },
    onTentativa
  );

  const dados = await resp.json();
  const cand = dados.candidates && dados.candidates[0];
  if (!cand) {
    throw new Error("A IA não retornou nenhum resultado. Tente novamente.");
  }

  const texto = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  // Se o modelo foi cortado por limite de tokens, o texto vem incompleto
  // (ex: só a primeira seção do resumo) mas não vazio — sem essa checagem
  // isso passaria como resumo "pronto" só que pela metade.
  if (texto && cand.finishReason === "MAX_TOKENS") {
    throw new Error(
      "O resumo foi cortado por ficar longo demais para a IA. Tente novamente ou escolha um nível de detalhe menor (normal/breve)."
    );
  }

  if (!texto) {
    const motivo = cand.finishReason ? ` (motivo: ${cand.finishReason})` : "";
    throw new Error(`A IA não gerou texto${motivo}.`);
  }
  return texto;
}

const ROTULOS_TIPO = {
  breve: "Resumo breve",
  normal: "Resumo normal",
  detalhado: "Resumo detalhado",
};

// Identidade da conversa. Antes o resumo era casado por `location.href`
// exato: qualquer query string que o Freshworks acrescente/remova sozinho
// (filtro, view, tracking) fazia o resumo já pronto virar "de outra
// conversa" e sumir da tela pra sempre. O caminho da URL é o que identifica
// o atendimento, então a query fica de fora da chave.
function idDaConversa(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${u.hash}`.replace(/\/+$/, "");
  } catch (_) {
    return href || "";
  }
}

// Guardamos um resumo POR CONVERSA. Com uma chave única global, começar um
// resumo na conversa B apagava o resultado já pronto da conversa A (a
// primeira coisa que processarGeracaoDeResumo faz é gravar o status
// "gerando"). O agente recebia a notificação de "pronto" da A, voltava pra
// ela e não encontrava nada.
const MAX_RESUMOS_GUARDADOS = 20;

// Duas gerações podem rodar em paralelo agora (uma por conversa), e ambas
// escrevem no mesmo objeto do storage. Sem serializar, o read-modify-write
// de uma sobrescreve o da outra.
let filaEscritaResumos = Promise.resolve();

function podarResumos(mapa) {
  const chaves = Object.keys(mapa);
  if (chaves.length <= MAX_RESUMOS_GUARDADOS) return mapa;
  const podado = {};
  chaves
    .sort((a, b) => (mapa[b]?.atualizadoEm || 0) - (mapa[a]?.atualizadoEm || 0))
    .slice(0, MAX_RESUMOS_GUARDADOS)
    .forEach((chave) => {
      podado[chave] = mapa[chave];
    });
  return podado;
}

// `mutador` recebe o mapa atual e devolve o novo — ou null pra desistir da
// escrita (ex: heartbeat que percebeu que a geração já terminou).
function atualizarResumos(mutador) {
  filaEscritaResumos = filaEscritaResumos
    .then(async () => {
      const { rwcResumos } = await api.storage.local.get("rwcResumos");
      const mapa = rwcResumos && typeof rwcResumos === "object" ? { ...rwcResumos } : {};
      const novo = mutador(mapa);
      if (!novo) return;
      await api.storage.local.set({ rwcResumos: podarResumos(novo) });
    })
    .catch((erro) => console.error("[rwc] falha ao gravar resumo", erro));
  return filaEscritaResumos;
}

function salvarResumo(dados) {
  return atualizarResumos((mapa) => {
    mapa[idDaConversa(dados.url)] = dados;
    return mapa;
  });
}

// Marca "ainda estou vivo" sem mexer no resto do estado — e desiste se a
// geração já terminou ou se outra geração assumiu esta conversa.
function tocarHeartbeat(contexto, aindaGerando) {
  return atualizarResumos((mapa) => {
    const chave = idDaConversa(contexto.url);
    const atual = mapa[chave];
    if (
      (aindaGerando && !aindaGerando()) ||
      !atual ||
      atual.status !== "gerando" ||
      atual.solicitacaoId !== contexto.solicitacaoId
    ) {
      return null;
    }
    mapa[chave] = { ...atual, atualizadoEm: Date.now() };
    return mapa;
  });
}

function notificar(titulo, mensagem) {
  api.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: titulo,
    message: mensagem,
  });
}

/* ==========================================================================
   Trabalhos duráveis.

   O keep-alive abaixo é um setInterval DENTRO do service worker — e é
   justamente isso que o Chrome estrangula quando o agente minimiza a janela
   e vai fazer outra coisa. Se o intervalo deixa de disparar por mais de
   ~30s, o worker é encerrado no meio do fetch pro Gemini: a promise morre
   sem passar pelo catch, nada é gravado, nenhuma notificação dispara, e o
   storage fica preso em "gerando" para sempre. O agente volta pro
   atendimento e não encontra resumo nenhum.

   Guardar o pedido (as `parts` já montadas) faz a geração deixar de ser
   volátil: um alarme reacorda o worker e o trabalho órfão é refeito do
   zero, sem depender de o agente estar com a aba aberta ou o Chrome em foco.
   ========================================================================== */
const ALARME_RETOMADA = "rwc-retomar-trabalhos";

// Tempo sem heartbeat a partir do qual o trabalho é considerado órfão.
// Menor que o GERANDO_TIMEOUT_MS do content script (120s) de propósito: a
// retomada tem que acontecer antes de a tela desistir e mostrar erro.
const TRABALHO_ORFAO_MS = 60000;

// Espera antes de tentar de novo quando a IA respondeu que está
// sobrecarregada. O alarme roda de minuto em minuto, então na prática a
// próxima tentativa cai no tique seguinte.
const ESPERA_REAGENDAMENTO_MS = 45000;

// Cobre tanto worker morto pelo navegador quanto pico de 503 no Gemini.
const MAX_RETOMADAS = 3;

// Trabalhos que ESTE worker já está executando agora — sem isso o alarme
// reiniciaria uma geração que só está demorando.
const emExecucao = new Set();

async function lerTrabalhos() {
  const { rwcTrabalhos } = await api.storage.local.get("rwcTrabalhos");
  return rwcTrabalhos && typeof rwcTrabalhos === "object" ? rwcTrabalhos : {};
}

async function salvarTrabalho(trabalho) {
  const trabalhos = await lerTrabalhos();
  trabalhos[trabalho.solicitacaoId] = trabalho;
  await api.storage.local.set({ rwcTrabalhos: trabalhos });
}

async function removerTrabalho(solicitacaoId) {
  const trabalhos = await lerTrabalhos();
  if (!trabalhos[solicitacaoId]) return;
  delete trabalhos[solicitacaoId];
  await api.storage.local.set({ rwcTrabalhos: trabalhos });
}

function agendarRetomada() {
  // O alarme sobrevive à morte do worker e o reacorda — é isso que o
  // setInterval não consegue fazer.
  api.alarms.create(ALARME_RETOMADA, { periodInMinutes: 1 });
}

async function retomarTrabalhosOrfaos() {
  let trabalhos;
  try {
    trabalhos = await lerTrabalhos();
  } catch (_) {
    return;
  }
  const pendentes = Object.values(trabalhos);
  if (!pendentes.length) return;

  const { rwcResumos } = await api.storage.local.get("rwcResumos");
  const mapa = rwcResumos || {};

  for (const trabalho of pendentes) {
    if (emExecucao.has(trabalho.solicitacaoId)) continue;

    const resumo = mapa[idDaConversa(trabalho.url)];
    // Se outra geração assumiu a conversa, ou ela já terminou, o trabalho
    // não interessa mais.
    if (!resumo || resumo.solicitacaoId !== trabalho.solicitacaoId) {
      await removerTrabalho(trabalho.solicitacaoId);
      continue;
    }
    if (resumo.status !== "gerando") {
      await removerTrabalho(trabalho.solicitacaoId);
      continue;
    }
    // Duas formas de ficar elegível: um reagendamento explícito (a IA estava
    // sobrecarregada e pedimos pra tentar mais tarde) ou o trabalho ter
    // ficado sem sinal de vida, sinal de que o worker morreu no meio.
    const naHora = resumo.proximaTentativaEm
      ? Date.now() >= resumo.proximaTentativaEm
      : Date.now() - (resumo.atualizadoEm || 0) >= TRABALHO_ORFAO_MS;
    if (!naHora) continue;

    const retomadas = (trabalho.retomadas || 0) + 1;
    if (retomadas > MAX_RETOMADAS) {
      console.warn("[rwc] trabalho excedeu as retomadas, desistindo", trabalho.solicitacaoId);
      await removerTrabalho(trabalho.solicitacaoId);
      const motivo = trabalho.ultimoErro
        ? `A IA seguiu indisponível após várias tentativas. Último retorno: ${trabalho.ultimoErro}`
        : "A geração foi interrompida pelo navegador e não pôde ser concluída. Tente novamente.";
      await salvarResumo({
        ...resumo,
        status: "erro",
        erro: motivo,
        atualizadoEm: Date.now(),
      });
      notificar("Rewind Chat — erro ao gerar resumo", motivo);
      continue;
    }

    console.warn("[rwc] retomando trabalho órfão", trabalho.solicitacaoId, `(${retomadas}/${MAX_RETOMADAS})`);
    // Marca antes do await pra um segundo disparo do alarme não começar a
    // mesma geração duas vezes.
    emExecucao.add(trabalho.solicitacaoId);
    await salvarTrabalho({ ...trabalho, retomadas });
    processarGeracaoDeResumo(
      { ...trabalho, retomadas, type: "rwc-gerar-resumo" },
      () => {
        /* ninguém esperando resposta numa retomada */
      }
    );
  }
}

api.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === ALARME_RETOMADA) retomarTrabalhosOrfaos();
});

// O worker pode acordar por vários motivos; em qualquer um deles vale checar
// se ficou trabalho pela metade da última vez que ele foi morto.
api.runtime.onStartup.addListener(retomarTrabalhosOrfaos);
api.runtime.onInstalled.addListener(() => {
  agendarRetomada();
  retomarTrabalhosOrfaos();
});
agendarRetomada();
retomarTrabalhosOrfaos();

// O MV3 pode encerrar o service worker por inatividade (~30s) mesmo com um
// fetch pendente, dependendo da versão do Chrome. Qualquer chamada a uma
// API da extensão reseta esse timer, então mantemos um "pulso" periódico
// enquanto a geração estiver rodando.
//
// Esse pulso também serve de heartbeat pro content script: sem ele,
// `atualizadoEm` ficaria travado no horário em que a geração começou, e uma
// conversa com vários áudios (download + retries no Gemini podem passar de
// 1-2 minutos) faria o content script achar que a geração morreu mesmo
// estando tudo normal. Atualizando `atualizadoEm` a cada pulso, o timeout
// do lado do content script passa a medir "tempo desde o último sinal de
// vida" em vez de "tempo desde o início".
// `aindaGerando` é checada antes de CADA operação assíncrona de storage
// (não só uma vez no início do tick) porque a leitura e a escrita do
// heartbeat não são atômicas: se a geração terminar (e gravar o resultado
// final) bem no meio dessas duas chamadas, sem essa checagem de novo logo
// antes do set() o heartbeat reescreveria "gerando" por cima do resultado
// já pronto/com erro.
function manterServiceWorkerAtivo(contexto, aindaGerando) {
  const intervalo = setInterval(() => {
    api.storage.local.get("rwcKeepAlive", () => void api.runtime.lastError);
    if (!aindaGerando()) return;
    tocarHeartbeat(contexto, aindaGerando);
  }, 15000);
  return () => clearInterval(intervalo);
}

// A partir do momento em que a mensagem chega aqui, a geração roda até o
// fim mesmo que a aba/conversa de origem seja fechada: o resultado (ou
// erro) é persistido em storage, e o content script — se ainda estiver
// aberto na mesma conversa — atualiza a tela via api.storage.onChanged.
// Se a aba já tiver fechado, o sendResponse simplesmente falha em silêncio;
// o trabalho em si não é interrompido por isso.
async function processarGeracaoDeResumo(mensagem, sendResponse) {
  const contexto = {
    status: "gerando",
    url: mensagem.url || "",
    tipo: mensagem.tipo || "",
    solicitacaoId: mensagem.solicitacaoId || "",
    atualizadoEm: Date.now(),
  };
  console.log("[rwc] geração iniciada", contexto.tipo, contexto.url);
  await salvarResumo(contexto);

  // Persiste o pedido ANTES de começar: se o Chrome matar o worker no meio
  // do fetch, é daqui que a retomada reconstrói o trabalho.
  emExecucao.add(contexto.solicitacaoId);
  await salvarTrabalho({
    solicitacaoId: contexto.solicitacaoId,
    url: contexto.url,
    tipo: contexto.tipo,
    parts: mensagem.parts,
    retomadas: mensagem.retomadas || 0,
    criadoEm: Date.now(),
  });

  let finalizado = false;
  let reagendado = false;
  const pararKeepAlive = manterServiceWorkerAtivo(contexto, () => !finalizado);
  try {
    const apiKey = mensagem.apiKey || (await obterChaveSalva());
    if (!apiKey) {
      finalizado = true;
      const erroDados = {
        ...contexto,
        status: "erro",
        erro: "Nenhuma chave de API do Gemini configurada.",
        atualizadoEm: Date.now(),
      };
      await salvarResumo(erroDados);
      console.warn("[rwc] sem chave de API configurada");
      sendResponse({ ok: false, error: erroDados.erro });
      return;
    }

    const texto = await gerarResumoIA(apiKey, mensagem.parts, () => {
      // Heartbeat: cada retry por sobrecarga do Gemini atualiza atualizadoEm,
      // então o content script sabe que ainda está vivo em vez de só ver
      // "gerando" parado por dezenas de segundos.
      tocarHeartbeat(contexto);
    });
    finalizado = true;
    const prontoDados = { ...contexto, status: "pronto", texto, atualizadoEm: Date.now() };
    await salvarResumo(prontoDados);
    console.log("[rwc] geração concluída", contexto.tipo, contexto.url);
    notificar("Rewind Chat", `${ROTULOS_TIPO[mensagem.tipo] || "Resumo"} pronto.`);
    sendResponse({ ok: true, text: texto });
  } catch (erro) {
    finalizado = true;
    const erroMsg = erro.message || "Ocorreu um erro inesperado.";
    const retomadasFeitas = mensagem.retomadas || 0;

    // Sobrecarga do Gemini (503/429) é temporária e não é culpa do agente —
    // não faz sentido devolver erro e obrigar a refazer a leitura da tela.
    // O trabalho guardado já tem o tipo de resumo escolhido e a transcrição,
    // então só reagendamos: o alarme tenta de novo sozinho e, pro agente, o
    // painel continua em "Gerando resumo...".
    if (erro.retentavel && retomadasFeitas < MAX_RETOMADAS) {
      reagendado = true;
      await salvarTrabalho({
        solicitacaoId: contexto.solicitacaoId,
        url: contexto.url,
        tipo: contexto.tipo,
        parts: mensagem.parts,
        retomadas: retomadasFeitas,
        ultimoErro: erroMsg,
        criadoEm: Date.now(),
      });
      await salvarResumo({
        ...contexto,
        status: "gerando",
        proximaTentativaEm: Date.now() + ESPERA_REAGENDAMENTO_MS,
        atualizadoEm: Date.now(),
      });
      console.warn("[rwc] IA indisponível, reagendando", contexto.solicitacaoId, erroMsg);
      sendResponse({ ok: false, error: erroMsg, reagendado: true });
      return;
    }

    const erroDados = { ...contexto, status: "erro", erro: erroMsg, atualizadoEm: Date.now() };
    await salvarResumo(erroDados);
    console.error("[rwc] geração falhou", erro);
    notificar("Rewind Chat — erro ao gerar resumo", erroMsg);
    sendResponse({ ok: false, error: erroMsg });
  } finally {
    pararKeepAlive();
    emExecucao.delete(contexto.solicitacaoId);
    // Só apaga o trabalho se ele realmente acabou. Num reagendamento ele
    // precisa sobreviver — é dele que a próxima tentativa é reconstruída.
    if (!reagendado) {
      await removerTrabalho(contexto.solicitacaoId).catch(() => {});
    }
  }
}

api.runtime.onMessage.addListener((mensagem, _sender, sendResponse) => {
  if (mensagem?.type === "rwc-obter-config-inicial") {
    (async () => {
      const existente = await obterChaveSalva();
      const geminiKey = existente || (await semearChaveDoConfigLocal());
      sendResponse({ geminiKey });
    })();
    return true;
  }

  if (mensagem?.type === "rwc-gerar-resumo") {
    processarGeracaoDeResumo(mensagem, (resposta) => {
      try {
        sendResponse(resposta);
      } catch (_) {
        // Aba de origem fechada — o resultado já está salvo em storage.
      }
    });
    return true;
  }

  return false;
});

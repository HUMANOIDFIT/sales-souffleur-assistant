const config = window.SALES_COACH_CONFIG || {}

const STORAGE_KEY = 'sales_souffleur_turn_assistant_v2'
const ROLE_LABELS = {
  client: 'Клиент',
  manager: 'Менеджер',
  system: 'Система'
}
const DEFAULT_REVIEW_HTML = '<p>После разговора здесь появится разбор: где потеряли продажу, где был хороший ход и что улучшить.</p>'

const state = {
  settings: {
    managerName: config.defaultManagerName || 'Менеджер',
    clubName: config.defaultClubName || 'HUMAN 24/7',
    productName: config.defaultProductName || 'клубная карта на 12 месяцев',
    coachMode: 'demo',
    knowledgeNotes: ''
  },
  audioEnabled: true,
  speechSupported: false,
  speechVoices: [],
  transcript: [],
  currentHint: {
    text: 'После паузы клиента здесь появится короткая фраза для живого ответа менеджера.',
    reason: 'Здесь будет краткий смысл клиентской реплики и логика ответа.',
    nextStep: 'После первых данных суфлер начнет вести менеджера к следующему микро-согласию.',
    badge: 'Ждем клиентскую реплику'
  },
  lastSpeaker: '',
  turnState: 'Turn detector не активирован',
  sessionStatus: 'idle',
  sessionStartedAt: null,
  latestClientText: '',
  managerReference: null,
  fullSessionChunks: [],
  mediaStream: null,
  fullRecorder: null,
  turnRecorder: null,
  turnChunks: [],
  currentTurnStartedAt: null,
  audioContext: null,
  analyser: null,
  vadBuffer: null,
  vadLoopId: null,
  lastVoiceAt: 0,
  isProcessingTurn: false,
  reviewHtml: DEFAULT_REVIEW_HTML
}

const els = {}

document.addEventListener('DOMContentLoaded', () => {
  restoreState()
  cacheElements()
  bindEvents()
  initSpeech()
  renderAll()
  startClock()
})

function cacheElements() {
  [
    'settingsForm',
    'managerName',
    'clubName',
    'productName',
    'coachMode',
    'knowledgeNotes',
    'recordReferenceBtn',
    'clearReferenceBtn',
    'referenceStatus',
    'startSessionBtn',
    'stopSessionBtn',
    'manualClientTurnBtn',
    'manualTurnInput',
    'browserNote',
    'modeBadge',
    'endpointHint',
    'sessionBadge',
    'durationBadge',
    'speakerBadge',
    'turnStateBadge',
    'hintLengthBadge',
    'clientTurnsBadge',
    'managerTurnsBadge',
    'vadStatus',
    'vadDetails',
    'latestClientLabel',
    'latestClientText',
    'transcriptList',
    'hintBadge',
    'voiceStatus',
    'toggleVoiceBtn',
    'replayHintBtn',
    'primaryHint',
    'hintSubtext',
    'hintReason',
    'nextStep',
    'knowledgeChips',
    'runReviewBtn',
    'exportMarkdownBtn',
    'exportJsonBtn',
    'exportAudioBtn',
    'reviewOutput'
  ].forEach((id) => {
    els[id] = document.getElementById(id)
  })
}

function bindEvents() {
  els.settingsForm.addEventListener('input', handleSettingsInput)
  els.recordReferenceBtn.addEventListener('click', recordManagerReference)
  els.clearReferenceBtn.addEventListener('click', clearManagerReference)
  els.startSessionBtn.addEventListener('click', startSession)
  els.stopSessionBtn.addEventListener('click', stopSession)
  els.manualClientTurnBtn.addEventListener('click', handleManualClientTurn)
  els.toggleVoiceBtn.addEventListener('click', toggleVoice)
  els.replayHintBtn.addEventListener('click', replayHint)
  els.runReviewBtn.addEventListener('click', runReview)
  els.exportMarkdownBtn.addEventListener('click', exportMarkdown)
  els.exportJsonBtn.addEventListener('click', exportJson)
  els.exportAudioBtn.addEventListener('click', exportAudio)
}

function initSpeech() {
  state.speechSupported = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined'
  if (!state.speechSupported) {
    state.audioEnabled = false
    return
  }

  const loadVoices = () => {
    state.speechVoices = window.speechSynthesis.getVoices()
    renderVoiceControls()
  }

  loadVoices()
  if (typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices)
  } else {
    window.speechSynthesis.onvoiceschanged = loadVoices
  }
}

function handleSettingsInput() {
  state.settings.managerName = normalizeText(els.managerName.value) || config.defaultManagerName || 'Менеджер'
  state.settings.clubName = normalizeText(els.clubName.value) || config.defaultClubName || 'HUMAN 24/7'
  state.settings.productName = normalizeText(els.productName.value) || config.defaultProductName || 'клубная карта на 12 месяцев'
  state.settings.coachMode = els.coachMode.value
  state.settings.knowledgeNotes = normalizeMultiline(els.knowledgeNotes.value)
  persistState()
  renderHeader()
  renderKnowledgeChips()
}

async function recordManagerReference() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    renderBrowserNote('Браузер не дает записать эталонный голос. Для live-режима нужен современный Chrome или Edge.')
    return
  }

  els.referenceStatus.textContent = 'Идет запись...'
  renderBrowserNote('Попроси менеджера спокойно говорить 4-5 секунд обычным тоном.')

  let stream
  let recorder
  const chunks = []

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
    recorder.ondataavailable = (event) => {
      if (event.data?.size) {
        chunks.push(event.data)
      }
    }
    recorder.start(250)

    window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, config.referenceDurationMs || 4500)

    await new Promise((resolve) => {
      recorder.onstop = resolve
    })

    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
    const dataUrl = await blobToDataUrl(blob)

    state.managerReference = {
      dataUrl,
      mimeType: blob.type || 'audio/webm',
      recordedAt: new Date().toISOString()
    }

    persistState()
    renderReferenceStatus()
    renderBrowserNote('Эталон голоса сохранен. Теперь live-режим сможет лучше различать менеджера и клиента.')
  } catch (error) {
    renderBrowserNote(`Не удалось записать голос менеджера: ${error.message || 'unknown error'}`)
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
    }
  }
}

function clearManagerReference() {
  state.managerReference = null
  renderReferenceStatus()
  persistState()
}

function toggleVoice() {
  state.audioEnabled = !state.audioEnabled
  if (!state.audioEnabled && state.speechSupported) {
    window.speechSynthesis.cancel()
  }
  renderVoiceControls()
  persistState()
}

function replayHint() {
  speakHint(state.currentHint.text)
}

async function startSession() {
  if (state.sessionStatus === 'running') return

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !(window.AudioContext || window.webkitAudioContext)) {
    renderBrowserNote('Для live turn detector нужен доступ к микрофону, MediaRecorder и AudioContext.')
    return
  }

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    state.fullSessionChunks = []
    state.fullRecorder = new MediaRecorder(state.mediaStream, { mimeType: pickMimeType() })
    state.fullRecorder.ondataavailable = (event) => {
      if (event.data?.size) {
        state.fullSessionChunks.push(event.data)
      }
    }
    state.fullRecorder.start(1000)

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const source = state.audioContext.createMediaStreamSource(state.mediaStream)
    state.analyser = state.audioContext.createAnalyser()
    state.analyser.fftSize = 2048
    state.vadBuffer = new Uint8Array(state.analyser.fftSize)
    source.connect(state.analyser)

    state.sessionStatus = 'running'
    state.sessionStartedAt = Date.now()
    state.turnState = state.settings.coachMode === 'live'
      ? 'Слушаем и ждем конец клиентской фразы'
      : 'Слушаем. Для подсказок в demo используй ручной тест реплики'

    renderAll()
    runVadLoop()
    persistState()
  } catch (error) {
    renderBrowserNote(`Не удалось запустить сессию: ${error.message || 'unknown error'}`)
  }
}

function stopSession() {
  state.sessionStatus = 'idle'
  state.turnState = 'Сессия остановлена'

  if (state.vadLoopId) {
    window.cancelAnimationFrame(state.vadLoopId)
    state.vadLoopId = null
  }

  if (state.turnRecorder && state.turnRecorder.state !== 'inactive') {
    state.turnRecorder.stop()
  }

  if (state.fullRecorder && state.fullRecorder.state !== 'inactive') {
    state.fullRecorder.stop()
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop())
    state.mediaStream = null
  }

  if (state.audioContext) {
    state.audioContext.close().catch(() => {})
    state.audioContext = null
  }

  state.analyser = null
  state.vadBuffer = null
  renderAll()
  persistState()
}

function runVadLoop() {
  if (state.sessionStatus !== 'running' || !state.analyser || !state.vadBuffer) return

  state.analyser.getByteTimeDomainData(state.vadBuffer)
  let sumSquares = 0
  for (let i = 0; i < state.vadBuffer.length; i += 1) {
    const normalized = (state.vadBuffer[i] - 128) / 128
    sumSquares += normalized * normalized
  }

  const rms = Math.sqrt(sumSquares / state.vadBuffer.length)
  const now = performance.now()
  const voiceDetected = rms > 0.04

  if (voiceDetected) {
    state.lastVoiceAt = now
    if (!state.turnRecorder && !state.isProcessingTurn) {
      startTurnCapture()
    }
    state.turnState = `Голос обнаружен, уровень ${rms.toFixed(3)}`
  } else if (state.turnRecorder && now - state.lastVoiceAt > (config.silenceDurationMs || 900)) {
    finishTurnCapture()
  } else {
    state.turnState = state.isProcessingTurn
      ? 'Обрабатываем завершенный turn'
      : 'Слушаем и ждем речевую активность'
  }

  renderHeader()
  renderVadMonitor(rms)
  state.vadLoopId = window.requestAnimationFrame(runVadLoop)
}

function startTurnCapture() {
  if (!state.mediaStream) return

  state.turnChunks = []
  state.currentTurnStartedAt = new Date().toISOString()
  state.turnRecorder = new MediaRecorder(state.mediaStream, { mimeType: pickMimeType() })
  state.turnRecorder.ondataavailable = (event) => {
    if (event.data?.size) {
      state.turnChunks.push(event.data)
    }
  }
  state.turnRecorder.start(250)
}

function finishTurnCapture() {
  const recorder = state.turnRecorder
  if (!recorder || recorder.state === 'inactive') return

  state.turnRecorder = null
  state.isProcessingTurn = true
  recorder.onstop = async () => {
    const blob = new Blob(state.turnChunks, { type: recorder.mimeType || 'audio/webm' })
    state.turnChunks = []

    if (blob.size < 5000) {
      state.isProcessingTurn = false
      return
    }

    if (state.settings.coachMode === 'live') {
      try {
        const result = await sendTurnToBackend(blob)
        applyTurnResult(result)
      } catch (error) {
        pushTranscript({
          role: 'system',
          text: `Ошибка live-обработки turn: ${error.message || 'unknown error'}`,
          meta: 'serverless'
        })
      }
    }

    state.isProcessingTurn = false
    renderAll()
    persistState()
  }

  recorder.stop()
}

async function sendTurnToBackend(blob) {
  const audioDataUrl = await blobToDataUrl(blob)
  const response = await fetch(config.assistantEndpoint || '/.netlify/functions/coach', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'process_turn',
      audioDataUrl,
      mimeType: blob.type || 'audio/webm',
      managerReferenceDataUrl: state.managerReference?.dataUrl || '',
      transcript: state.transcript.slice(-20),
      settings: state.settings
    })
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data?.ok || !data?.turn) {
    throw new Error(data?.error || `HTTP ${response.status}`)
  }
  return data.turn
}

function applyTurnResult(turn) {
  const segments = Array.isArray(turn.segments) ? turn.segments : []
  if (!segments.length) {
    return
  }

  segments.forEach((segment) => {
    const role = mapSpeakerLabel(segment.speaker)
    pushTranscript({
      role,
      text: normalizeText(segment.text),
      meta: `${segment.speaker || 'unknown'} · ${segment.start ?? 0}-${segment.end ?? 0}s`
    })
  })

  state.lastSpeaker = mapSpeakerLabel(turn.primarySpeaker || '')

  if (turn.clientText) {
    state.latestClientText = turn.clientText
  }

    if (turn.shouldRespond && turn.hint) {
      updateCurrentHint({
      text: turn.hint,
      reason: turn.reason || 'Клиент закончил ход, суфлер предлагает следующую живую формулировку.',
      nextStep: turn.nextStep || 'Подведи клиента к следующему маленькому согласию.',
      badge: turn.badge || 'Клиент закончил говорить'
      }, true)
    }
}

function handleManualClientTurn() {
  const text = normalizeText(els.manualTurnInput.value)
  if (!text) return

  els.manualTurnInput.value = ''

  pushTranscript({
    role: 'client',
    text,
    meta: 'manual demo'
  })

  state.latestClientText = text
  state.lastSpeaker = 'client'

  const result = buildDemoHint(text, state.settings)
  updateCurrentHint(result, true)
  renderAll()
  persistState()
}

function buildDemoHint(clientText, settings) {
  const text = clientText.toLowerCase()
  const productName = settings.productName || 'клубная карта'

  let hint = `Уточни цель клиента и свяжи ${productName} с его реальной задачей, а потом мягко предложи следующий шаг.`
  let reason = 'Клиент раскрыл контекст. Нужна быстрая диагностика без длинной презентации.'
  let nextStep = 'После уточнения мотива предложи один логичный тариф и мини-действие.'
  let badge = 'Demo: диагностическая подсказка'

  if (/(дорого|цена|дороговато|скидк|дороже)/i.test(text)) {
    hint = 'Признай вопрос цены, уточни частоту посещений и покажи, как тариф окупается в реальном режиме клиента.'
    reason = 'Сейчас важно не спорить с ценой, а вернуть разговор к ценности и режиму использования.'
    nextStep = 'Сначала уточни сценарий посещений, потом предложи один подходящий вариант.'
    badge = 'Demo: возражение по цене'
  } else if (/(подумаю|позже|не сейчас|созвон|пока не готов)/i.test(text)) {
    hint = 'Не отпускай клиента в пустое подумать: спроси, что именно мешает решиться сейчас, и сними этот барьер.'
    reason = 'Откладывание почти всегда означает непроговоренный страх или неясную ценность.'
    nextStep = 'Вытащи истинную причину паузы и закрепи следующий контакт или бронь.'
    badge = 'Demo: клиент откладывает решение'
  } else if (/(муж|жена|посоветуюсь|обсудить дома|семь)/i.test(text)) {
    hint = 'Помоги клиенту коротко пересказать ценность дома: дай 2 аргумента и договорись о следующем созвоне.'
    reason = 'Клиенту нужен не напор, а удобная аргументация для согласования с близкими.'
    nextStep = 'Закрепи время следующего касания, чтобы решение не зависло.'
    badge = 'Demo: решение нужно согласовать'
  } else if (/(сравниваю|другой клуб|конкурент|дешевле у других)/i.test(text)) {
    hint = 'Не спорь с конкурентом: уточни критерии выбора и покажи, где именно ваш формат удобнее для клиента.'
    reason = 'Побеждает не тот, кто хвалит себя громче, а кто помогает сравнить по важным критериям.'
    nextStep = 'Собери критерии и сведи выбор к одному решающему фактору.'
    badge = 'Demo: сравнение с конкурентом'
  }

  const finalHint = fitHintLength(hint)
  return {
    text: finalHint,
    reason,
    nextStep,
    badge
  }
}

function fitHintLength(input) {
  const min = config.minHintLength || 100
  const max = config.maxHintLength || 120
  const fillers = [
    ' Уточни цель и веди мягко.',
    ' Без давления, но с следующим шагом.',
    ' Держи фокус на ценности.'
  ]

  let value = normalizeText(input)
  let fillerIndex = 0

  while (value.length < min && fillerIndex < fillers.length) {
    value = normalizeText(`${value} ${fillers[fillerIndex]}`)
    fillerIndex += 1
  }

  if (value.length > max) {
    let cutIndex = value.lastIndexOf(' ', max - 1)
    if (cutIndex < Math.floor(min * 0.8)) {
      cutIndex = max - 1
    }
    value = `${value.slice(0, cutIndex).trim().replace(/[,.!;:]+$/, '')}...`
  }

  if (value.length < min) {
    const lastPad = ' Уточни мотив и зафиксируй следующий шаг.'
    value = normalizeText(`${value} ${lastPad}`)
    if (value.length > max) {
      let cutIndex = value.lastIndexOf(' ', max - 1)
      if (cutIndex < Math.floor(min * 0.8)) {
        cutIndex = max - 1
      }
      value = `${value.slice(0, cutIndex).trim().replace(/[,.!;:]+$/, '')}...`
    }
  }

  return value
}

async function runReview() {
  if (!state.transcript.length) {
    state.reviewHtml = '<p>Сначала накопи хотя бы несколько сегментов разговора.</p>'
    renderReview()
    return
  }

  if (state.settings.coachMode === 'live') {
    try {
      const response = await fetch(config.assistantEndpoint || '/.netlify/functions/coach', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'review',
          transcript: state.transcript,
          settings: state.settings
        })
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.ok || !data?.review) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      state.reviewHtml = renderReviewHtml(data.review)
    } catch (error) {
      state.reviewHtml = buildLocalReviewHtml(error.message)
    }
  } else {
    state.reviewHtml = buildLocalReviewHtml('')
  }

  renderReview()
  persistState()
}

function buildLocalReviewHtml(liveError) {
  const clientTurns = state.transcript.filter((item) => item.role === 'client')
  const managerTurns = state.transcript.filter((item) => item.role === 'manager')
  const wins = []
  const mistakes = []
  const nextActions = []

  if (clientTurns.length >= managerTurns.length) {
    wins.push('Клиент говорил не меньше менеджера. Это дает материал для диагностики и мягкого закрытия.')
  } else {
    mistakes.push('Менеджер говорил больше клиента. Суфлер должен чаще вести через короткие вопросы.')
  }

  if (managerTurns.some((item) => item.text.includes('?'))) {
    wins.push('В разговоре есть уточняющие вопросы, а не только презентация продукта.')
  } else {
    mistakes.push('В стенограмме почти нет уточняющих вопросов. Это снижает точность продажи.')
  }

  if (state.transcript.some((item) => /рассроч|оформ|бронь|когда удобно/i.test(item.text))) {
    wins.push('Есть попытка перевести разговор в конкретный следующий шаг.')
  } else {
    mistakes.push('Следующий шаг к продаже не был обозначен достаточно явно.')
  }

  nextActions.push('Усиль блок диагностики: цель клиента, реальная частота посещений, главный барьер.')
  nextActions.push('После каждого возражения сначала признавай логику клиента, потом веди к следующему шагу.')
  if (liveError) {
    nextActions.push(`Live-разбор не сработал: ${liveError}. Проверить serverless-функцию и ключ OpenAI.`)
  }

  return `
    <p><strong>Локальный разбор звонка</strong></p>
    <h3>Что получилось</h3>
    <ul>${wins.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>Что мешало продаже</h3>
    <ul>${mistakes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>Что улучшить в следующем разговоре</h3>
    <ul>${nextActions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  `
}

function renderReviewHtml(review) {
  return `
    <p><strong>Оценка разговора:</strong> ${Math.round(Number(review.score || 0))}/100</p>
    <h3>Что получилось</h3>
    <ul>${sanitizeList(review.wins).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>Где потеряна продажа</h3>
    <ul>${sanitizeList(review.mistakes).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>Что делать дальше</h3>
    <ul>${sanitizeList(review.nextActions).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <p><strong>Заметка:</strong> ${escapeHtml(review.coachNote || '')}</p>
  `
}

function exportMarkdown() {
  const lines = [
    '# Sales Souffleur Transcript',
    '',
    `- Менеджер: ${state.settings.managerName}`,
    `- Клуб: ${state.settings.clubName}`,
    `- Продукт: ${state.settings.productName}`,
    `- Режим: ${state.settings.coachMode}`,
    '',
    '## Последняя подсказка',
    '',
    state.currentHint.text,
    '',
    '## Стенограмма',
    ''
  ]

  state.transcript.forEach((item) => {
    lines.push(`- [${formatTime(item.createdAt)}] **${ROLE_LABELS[item.role]}**: ${item.text}`)
  })

  lines.push('')
  lines.push('## Разбор')
  lines.push('')
  lines.push(stripHtml(state.reviewHtml))

  downloadText(lines.join('\n'), buildExportName('md'), 'text/markdown;charset=utf-8')
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    currentHint: state.currentHint,
    transcript: state.transcript,
    reviewHtml: state.reviewHtml,
    latestClientText: state.latestClientText
  }
  downloadText(JSON.stringify(payload, null, 2), buildExportName('json'), 'application/json;charset=utf-8')
}

function exportAudio() {
  if (!state.fullSessionChunks.length) {
    state.reviewHtml = '<p>Аудиофайл пока не собран. Запусти сессию и дай браузеру доступ к микрофону.</p>'
    renderReview()
    return
  }
  const blob = new Blob(state.fullSessionChunks, { type: pickMimeType() })
  downloadBlob(blob, buildExportName('webm'))
}

function pushTranscript({ role, text, meta }) {
  if (!normalizeText(text)) return
  state.transcript.push({
    role,
    text: normalizeText(text),
    meta: meta || '',
    createdAt: new Date().toISOString()
  })
  state.transcript = state.transcript.slice(-300)
}

function updateCurrentHint(nextHint, shouldSpeak) {
  state.currentHint = {
    ...state.currentHint,
    ...nextHint
  }
  if (shouldSpeak) {
    speakHint(state.currentHint.text)
  }
}

function speakHint(text) {
  if (!state.audioEnabled || !state.speechSupported) return
  const phrase = normalizeText(text)
  if (!phrase) return

  const utterance = new SpeechSynthesisUtterance(phrase)
  utterance.lang = 'ru-RU'
  utterance.rate = 1.04
  utterance.pitch = 1

  const preferredVoice = pickPreferredVoice()
  if (preferredVoice) {
    utterance.voice = preferredVoice
  }

  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(utterance)
}

function pickPreferredVoice() {
  if (!state.speechVoices.length) return null
  return state.speechVoices.find((voice) => voice.lang === 'ru-RU')
    || state.speechVoices.find((voice) => String(voice.lang || '').toLowerCase().startsWith('ru'))
    || state.speechVoices[0]
}

function renderAll() {
  populateForm()
  renderReferenceStatus()
  renderHeader()
  renderVadMonitor(0)
  renderTranscript()
  renderHint()
  renderVoiceControls()
  renderKnowledgeChips()
  renderReview()
}

function populateForm() {
  els.managerName.value = state.settings.managerName
  els.clubName.value = state.settings.clubName
  els.productName.value = state.settings.productName
  els.coachMode.value = state.settings.coachMode
  els.knowledgeNotes.value = state.settings.knowledgeNotes
}

function renderReferenceStatus() {
  els.referenceStatus.textContent = state.managerReference ? 'Эталон сохранен' : 'Голос не записан'
}

function renderHeader() {
  els.modeBadge.textContent = state.settings.coachMode === 'live' ? 'Live diarization' : 'Demo'
  els.endpointHint.textContent = state.settings.coachMode === 'live'
    ? 'Сегмент уходит в /.netlify/functions/coach -> diarization -> короткая подсказка'
    : 'Demo работает вручную через тест клиентской реплики'
  els.sessionBadge.textContent = state.sessionStatus === 'running' ? 'Диалог активен' : 'Ожидаем старт'
  els.speakerBadge.textContent = ROLE_LABELS[state.lastSpeaker] || 'Не определен'
  els.turnStateBadge.textContent = state.turnState
  els.hintLengthBadge.textContent = `${state.currentHint.text.length} / ${config.maxHintLength || 120}`
}

function renderVadMonitor(rms) {
  els.vadStatus.textContent = state.sessionStatus === 'running'
    ? (state.isProcessingTurn ? 'Обработка turn' : 'Слушаем')
    : 'Ожидание'
  els.vadDetails.textContent = state.sessionStatus === 'running'
    ? `${state.turnState}. Порог тишины: ${config.silenceDurationMs || 900} мс. RMS: ${rms.toFixed(3)}`
    : 'После старта приложение ловит голосовую активность и ждет паузу клиента.'
  els.latestClientLabel.textContent = state.latestClientText ? 'Распознано' : 'Еще нет данных'
  els.latestClientText.textContent = state.latestClientText || 'После первой клиентской реплики здесь появится распознанный текст.'
}

function renderTranscript() {
  const clientCount = state.transcript.filter((item) => item.role === 'client').length
  const managerCount = state.transcript.filter((item) => item.role === 'manager').length
  els.clientTurnsBadge.textContent = `Клиент: ${clientCount}`
  els.managerTurnsBadge.textContent = `Менеджер: ${managerCount}`

  if (!state.transcript.length) {
    els.transcriptList.innerHTML = '<article class="transcript-item system"><p>Сегменты разговора пока не появились. Можно начать live-сессию или проверить подсказку вручную.</p></article>'
    return
  }

  els.transcriptList.innerHTML = state.transcript.map((item) => `
    <article class="transcript-item ${item.role}">
      <div class="transcript-meta">
        <strong>${ROLE_LABELS[item.role]}</strong>
        <span>${formatTime(item.createdAt)}${item.meta ? ` · ${escapeHtml(item.meta)}` : ''}</span>
      </div>
      <p>${escapeHtml(item.text)}</p>
    </article>
  `).join('')
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight
}

function renderHint() {
  els.hintBadge.textContent = state.currentHint.badge
  els.primaryHint.textContent = state.currentHint.text
  els.hintSubtext.textContent = state.audioEnabled
    ? 'Эта же подсказка остается на мониторе текстом и озвучивается голосом.'
    : 'Подсказка остается на мониторе текстом. Озвучку можно включить в один клик.'
  els.hintReason.textContent = state.currentHint.reason
  els.nextStep.textContent = state.currentHint.nextStep
}

function renderVoiceControls() {
  els.voiceStatus.textContent = state.speechSupported
    ? `Озвучка: ${state.audioEnabled ? 'вкл' : 'выкл'}`
    : 'Озвучка недоступна'
  els.toggleVoiceBtn.textContent = state.audioEnabled ? 'Выключить озвучку' : 'Включить озвучку'
  els.toggleVoiceBtn.disabled = !state.speechSupported
  els.replayHintBtn.disabled = !state.speechSupported || !normalizeText(state.currentHint.text)
}

function renderKnowledgeChips() {
  const entries = state.settings.knowledgeNotes
    .split(/\n|,/)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 6)

  const chips = entries.length ? entries : ['приоритет 12 месяцев', 'возражения клиента', 'доступ 24/7', 'продукт карт', 'преимущества клуба']
  els.knowledgeChips.innerHTML = chips.map((item) => `<span class="keyword">${escapeHtml(item)}</span>`).join('')
}

function renderReview() {
  els.reviewOutput.innerHTML = state.reviewHtml
}

function renderBrowserNote(message) {
  els.browserNote.textContent = message
}

function startClock() {
  window.setInterval(() => {
    els.durationBadge.textContent = formatDuration(state.sessionStartedAt)
  }, 1000)
}

function restoreState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    if (!saved || typeof saved !== 'object') return
    state.settings = { ...state.settings, ...(saved.settings || {}) }
    state.transcript = Array.isArray(saved.transcript) ? saved.transcript : []
    state.currentHint = saved.currentHint || state.currentHint
    state.audioEnabled = saved.audioEnabled !== false
    state.lastSpeaker = saved.lastSpeaker || ''
    state.sessionStartedAt = saved.sessionStartedAt || null
    state.latestClientText = saved.latestClientText || ''
    state.reviewHtml = saved.reviewHtml || state.reviewHtml
    state.managerReference = saved.managerReference || null
  } catch (_) {
    // ignore broken local state
  }
}

function persistState() {
  const payload = {
    settings: state.settings,
    transcript: state.transcript,
    currentHint: state.currentHint,
    audioEnabled: state.audioEnabled,
    lastSpeaker: state.lastSpeaker,
    sessionStartedAt: state.sessionStartedAt,
    latestClientText: state.latestClientText,
    reviewHtml: state.reviewHtml,
    managerReference: state.managerReference
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

function pickMimeType() {
  if (window.MediaRecorder?.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus'
  }
  if (window.MediaRecorder?.isTypeSupported('audio/webm')) {
    return 'audio/webm'
  }
  return 'audio/webm'
}

function mapSpeakerLabel(value) {
  const speaker = String(value || '').toLowerCase()
  if (speaker.includes('manager') || speaker.includes('agent')) return 'manager'
  if (speaker.includes('client') || speaker.includes('customer')) return 'client'
  return 'system'
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result || ''))
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function downloadText(content, filename, mimeType) {
  downloadBlob(new Blob([content], { type: mimeType }), filename)
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function buildExportName(extension) {
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  return `sales-souffleur-${stamp}.${extension}`
}

function sanitizeList(items) {
  const list = Array.isArray(items) ? items : []
  return list.map((item) => normalizeText(item)).filter(Boolean)
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeMultiline(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim()
}

function formatTime(value) {
  const date = new Date(value)
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatDuration(start) {
  if (!start) return '00:00'
  const total = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

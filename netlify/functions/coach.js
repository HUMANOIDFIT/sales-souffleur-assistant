'use strict'

const PLAYBOOK = require('../../knowledge-base/club-sales-playbook.json')

const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize'
const COACH_MODEL = process.env.OPENAI_COACH_MODEL || 'gpt-4.1-mini'

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(500, { error: 'OPENAI_API_KEY is not configured.' })
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch (_) {
    return json(400, { error: 'Body must be valid JSON.' })
  }

  const action = String(body.action || 'process_turn').trim()

  try {
    if (action === 'review') {
      const review = await buildReview(body)
      return json(200, { ok: true, review })
    }

    if (action === 'process_turn') {
      const turn = await processTurn(body)
      return json(200, { ok: true, turn })
    }

    return json(400, { error: `Unknown action: ${action}` })
  } catch (error) {
    return json(500, { error: error.message || 'Unknown server error' })
  }
}

async function processTurn(body) {
  const audioDataUrl = String(body.audioDataUrl || '')
  const managerReferenceDataUrl = String(body.managerReferenceDataUrl || '')
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {}
  const transcript = Array.isArray(body.transcript) ? body.transcript.slice(-20) : []

  if (!audioDataUrl) {
    throw new Error('audioDataUrl is required for process_turn.')
  }

  const diarized = await transcribeTurn({
    audioDataUrl,
    mimeType: String(body.mimeType || 'audio/webm'),
    managerReferenceDataUrl
  })

  const rawSegments = Array.isArray(diarized.segments) ? diarized.segments : []
  const normalizedSegments = rawSegments
    .map((segment) => ({
      speaker: normalizeSpeaker(segment.speaker, Boolean(managerReferenceDataUrl)),
      start: Number(segment.start || 0),
      end: Number(segment.end || 0),
      text: String(segment.text || '').trim()
    }))
    .filter((segment) => segment.text)

  if (!normalizedSegments.length) {
    return {
      segments: [],
      shouldRespond: false,
      primarySpeaker: 'system'
    }
  }

  const primarySegment = normalizedSegments[normalizedSegments.length - 1]
  const clientSegments = normalizedSegments.filter((segment) => segment.speaker === 'client')
  const clientText = clientSegments.map((segment) => segment.text).join(' ').trim()
  const shouldRespond = primarySegment.speaker === 'client' && Boolean(clientText)

  if (!shouldRespond) {
    return {
      segments: normalizedSegments,
      shouldRespond: false,
      primarySpeaker: primarySegment.speaker
    }
  }

  const coaching = await buildHint({
    clientText,
    transcript,
    settings
  })

  return {
    segments: normalizedSegments,
    primarySpeaker: primarySegment.speaker,
    clientText,
    shouldRespond: true,
    hint: coaching.hint,
    reason: coaching.reason,
    nextStep: coaching.nextStep,
    badge: coaching.badge
  }
}

async function transcribeTurn({ audioDataUrl, mimeType, managerReferenceDataUrl }) {
  const form = new FormData()
  form.append('model', TRANSCRIBE_MODEL)
  form.append('response_format', 'diarized_json')
  form.append('language', 'ru')
  form.append('chunking_strategy', 'auto')
  form.append('file', dataUrlToBlob(audioDataUrl, mimeType), buildFileName(mimeType))

  if (managerReferenceDataUrl) {
    form.append('known_speaker_names[]', 'manager')
    form.append('known_speaker_references[]', managerReferenceDataUrl)
  }

  const response = await fetch(TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error?.message || `Transcription HTTP ${response.status}`)
  }

  return data
}

async function buildHint({ clientText, transcript, settings }) {
  const knowledgeContext = buildKnowledgeContext(clientText, settings)
  const prompt = [
    'Ты главный продажник-суфлер для менеджера.',
    'Нужно ответить только после реплики клиента.',
    'Верни JSON без markdown.',
    'Подсказка должна быть по-русски, готовой для живого произнесения менеджером.',
    'Подсказка должна быть строго в диапазоне 100-120 символов.',
    'Тон: мягкий, уверенный, без давления.',
    'Если можно, держи курс на 12 месяцев. Если это нереалистично, переводи на 6 месяцев. 1 месяц — только крайний компромисс.',
    '',
    `Менеджер: ${settings.managerName || 'Менеджер'}`,
    `Компания: ${settings.clubName || 'Клуб'}`,
    `Продукт: ${settings.productName || 'клубная карта'}`,
    `База знаний / тезисы: ${settings.knowledgeNotes || 'нет дополнительных тезисов'}`,
    '',
    'Структурированная база знаний клуба:',
    knowledgeContext,
    '',
    'Последние реплики разговора:',
    formatTranscript(transcript),
    '',
    `Последняя реплика клиента: ${clientText}`,
    '',
    'Верни JSON строго в виде:',
    '{',
    '  "hint": "100-120 символов",',
    '  "reason": "кратко зачем именно эта формулировка",',
    '  "nextStep": "следующий шаг к продаже",',
    '  "badge": "короткий статус интерфейса"',
    '}'
  ].join('\n')

  const raw = await askResponses(prompt, 300)
  const parsed = safeJsonParse(raw)
  if (!parsed) {
    throw new Error('Failed to parse coaching JSON from Responses API.')
  }

  return {
    hint: coerceHintLength(String(parsed.hint || '').trim() || 'Уточните, что для вас решающе, и я подберу формат без лишних опций, чтобы решение было спокойным.'),
    reason: String(parsed.reason || '').trim() || 'Фраза удерживает мягкий контроль разговора и возвращает менеджера к диагностике.',
    nextStep: String(parsed.nextStep || '').trim() || 'После ответа собери критерий выбора и предложи один конкретный вариант.',
    badge: String(parsed.badge || '').trim() || 'Клиент закончил говорить'
  }
}

async function buildReview(body) {
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {}
  const transcript = Array.isArray(body.transcript) ? body.transcript.slice(-80) : []
  const knowledgeContext = buildKnowledgeContext(transcript.map((item) => item.text).join(' '), settings)

  const prompt = [
    'Ты разбираешь разговор менеджера по продажам и ищешь ошибки и точки усиления.',
    'Верни JSON без markdown.',
    '',
    `Компания: ${settings.clubName || 'Клуб'}`,
    `Продукт: ${settings.productName || 'клубная карта'}`,
    `Тезисы базы знаний: ${settings.knowledgeNotes || 'не указаны'}`,
    '',
    'Ключевая логика продаж и продукта:',
    knowledgeContext,
    '',
    'Стенограмма:',
    formatTranscript(transcript),
    '',
    'Верни JSON строго в виде:',
    '{',
    '  "score": 0,',
    '  "wins": ["сильная сторона 1", "сильная сторона 2"],',
    '  "mistakes": ["ошибка 1", "ошибка 2"],',
    '  "nextActions": ["действие 1", "действие 2"],',
    '  "coachNote": "один короткий вывод"',
    '}'
  ].join('\n')

  const raw = await askResponses(prompt, 500)
  const parsed = safeJsonParse(raw)
  if (!parsed) {
    throw new Error('Failed to parse review JSON from Responses API.')
  }

  return {
    score: Number(parsed.score || 0),
    wins: sanitizeList(parsed.wins, ['Не удалось выделить сильные стороны']),
    mistakes: sanitizeList(parsed.mistakes, ['Не удалось выделить ошибки']),
    nextActions: sanitizeList(parsed.nextActions, ['Нужно повторно проверить стенограмму и следующий шаг']),
    coachNote: String(parsed.coachNote || '').trim()
  }
}

async function askResponses(prompt, maxOutputTokens) {
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: COACH_MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt
            }
          ]
        }
      ],
      max_output_tokens: maxOutputTokens || 400
    })
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error?.message || `Responses HTTP ${response.status}`)
  }

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  if (Array.isArray(data.output)) {
    const text = data.output
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .map((part) => part?.text || '')
      .join('\n')
      .trim()
    if (text) return text
  }

  throw new Error('Responses API returned no text output.')
}

function normalizeSpeaker(value, hasManagerReference) {
  const label = String(value || '').trim()
  if (!label) return 'client'
  if (label.toLowerCase() === 'manager' || label.toLowerCase() === 'agent') return 'manager'
  if (!hasManagerReference) return 'client'
  return 'client'
}

function buildKnowledgeContext(clientText, settings) {
  const lower = normalizeText(clientText).toLowerCase()
  const lines = []

  lines.push(`Приоритет продажи: ${PLAYBOOK.core_rules.priority_order.join(' -> ')}`)
  lines.push(`Логика: ${PLAYBOOK.core_rules.priority_explanation}`)
  lines.push(`Позиционирование 12 месяцев: ${PLAYBOOK.core_rules.positioning['12_months']}`)
  lines.push(`Позиционирование 6 месяцев: ${PLAYBOOK.core_rules.positioning['6_months']}`)
  lines.push(`Позиционирование 1 месяца: ${PLAYBOOK.core_rules.positioning['1_months'] || PLAYBOOK.core_rules.positioning['1_month']}`)
  lines.push(`Стиль: ${PLAYBOOK.core_rules.response_style.join(', ')}`)

  const matchedObjections = PLAYBOOK.objections.filter((item) => item.triggers.some((trigger) => lower.includes(trigger))).slice(0, 2)
  if (matchedObjections.length) {
    matchedObjections.forEach((item) => {
      lines.push(`Возражение ${item.id}: скрытый смысл — ${item.hidden_meaning}`)
      lines.push(`Возражение ${item.id}: куда вести — ${item.steer}`)
      lines.push(`Возражение ${item.id}: нельзя — ${item.do_not.join('; ')}`)
    })
  }

  const relevantAdvantages = PLAYBOOK.advantages.filter((item) => item.triggers.some((trigger) => lower.includes(trigger))).slice(0, 2)
  if (relevantAdvantages.length) {
    relevantAdvantages.forEach((item) => {
      lines.push(`Преимущество клуба: ${item.title} — ${item.value}`)
    })
  }

  const relevantCards = selectRelevantCards(lower)
  relevantCards.forEach((card) => {
    const priceParts = []
    if (card.monthly_payment) priceParts.push(`ежемесячно ${card.monthly_payment} руб.`)
    if (card.cash_price) priceParts.push(`наличными ${card.cash_price} руб.`)
    lines.push(`Карта: ${card.label}. ${card.framing}. ${priceParts.join(', ')}.`)
  })

  if (settings.knowledgeNotes) {
    lines.push(`Дополнительные тезисы менеджера: ${settings.knowledgeNotes}`)
  }

  return lines.join('\n')
}

function selectRelevantCards(lower) {
  const wantsNoEvening = /(без вечера|вечер не нужен|днем|днём|до 17|после 22|дневн)/.test(lower)
  const filtered = PLAYBOOK.cards
    .filter((card) => wantsNoEvening ? !card.evening_access : card.evening_access)
    .sort((a, b) => a.priority - b.priority || b.duration_months - a.duration_months)
  return filtered.slice(0, 3)
}

function coerceHintLength(input) {
  const min = 100
  const max = 120
  const fillers = [
    ' Уточните цель и следующий шаг.',
    ' Без давления, но уверенно.',
    ' Сведите выбор к одному критерию.'
  ]

  let value = normalizeText(input)
  let index = 0

  while (value.length < min && index < fillers.length) {
    value = normalizeText(`${value} ${fillers[index]}`)
    index += 1
  }

  if (value.length > max) {
    let cut = value.lastIndexOf(' ', max - 1)
    if (cut < Math.floor(min * 0.8)) {
      cut = max - 1
    }
    value = `${value.slice(0, cut).trim().replace(/[,:;.!-]+$/, '')}...`
  }

  if (value.length < min) {
    const tail = ' Уточните цель и плавно подведите к выбору.'
    value = normalizeText(`${value} ${tail}`)
    if (value.length > max) {
      let cut = value.lastIndexOf(' ', max - 1)
      if (cut < Math.floor(min * 0.8)) {
        cut = max - 1
      }
      value = `${value.slice(0, cut).trim().replace(/[,:;.!-]+$/, '')}...`
    }
  }

  return value
}

function dataUrlToBlob(dataUrl, mimeType) {
  const match = String(dataUrl || '').match(/^data:(.+?);base64,(.+)$/)
  if (!match) {
    throw new Error('Invalid data URL received.')
  }
  const actualMime = match[1] || mimeType || 'audio/webm'
  const buffer = Buffer.from(match[2], 'base64')
  return new Blob([buffer], { type: actualMime })
}

function buildFileName(mimeType) {
  if (String(mimeType || '').includes('wav')) return 'turn.wav'
  if (String(mimeType || '').includes('mp4')) return 'turn.m4a'
  return 'turn.webm'
}

function formatTranscript(transcript) {
  if (!transcript.length) return 'Стенограмма пуста.'
  return transcript
    .map((item) => `[${String(item.role || 'unknown')}] ${String(item.text || '').trim()}`)
    .join('\n')
}

function safeJsonParse(value) {
  const source = String(value || '').trim()
  if (!source) return null

  try {
    return JSON.parse(source)
  } catch (_) {
    const fenced = source.match(/```json\s*([\s\S]*?)```/i) || source.match(/```([\s\S]*?)```/i)
    if (fenced) {
      try {
        return JSON.parse(fenced[1])
      } catch (_) {
        return null
      }
    }

    const firstBrace = source.indexOf('{')
    const lastBrace = source.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(source.slice(firstBrace, lastBrace + 1))
      } catch (_) {
        return null
      }
    }
  }

  return null
}

function sanitizeList(items, fallback) {
  if (!Array.isArray(items) || !items.length) return fallback
  return items.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(payload)
  }
}

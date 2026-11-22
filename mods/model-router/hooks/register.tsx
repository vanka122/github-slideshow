import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Tier } from '../types'

const choice = atom({ plugin: 'model-router', key: 'choice' } as const, null, { shape: 'choice-1' })
const isOn = atom({ plugin: 'model-router', key: 'isOn' } as const, true)

const LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const SIMPLE = /(переимен|rename|опечат|typo|поправь текст|исправь текст|найди файл|где лежит|find file|покажи файл|какой файл|формат|отступ|запятую|перевед)/i
const HARD = /(архитект|architect|рефактор|refactor|спроектир|design|миграц|migrat|перепиши (весь|всё|проект)|с нуля|весь проект|большие изменения|оптимиз.*производ|безопасност|security|многопоточ|concurren|распредел)/i

// Быстрая оценка без затрат: ключевые слова и длина задачи.
function guess(text: string): { tier: Tier; reason: string } {
  if (HARD.test(text)) return { tier: 'opus', reason: 'похоже на архитектуру или большие изменения' }
  if (SIMPLE.test(text) && text.length < 300) return { tier: 'haiku', reason: 'простая точечная задача' }
  if (text.length > 1500) return { tier: 'opus', reason: 'длинная, многосоставная задача' }
  return { tier: 'sonnet', reason: 'обычная задача' }
}

// Оценка через Haiku: дешёвый короткий вызов, при сбое — оценка по словам.
async function classify($: EngineInterface, text: string): Promise<{ tier: Tier; reason: string }> {
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 80,
    timeoutMs: 8000,
    system:
      'Ты оцениваешь сложность задачи для программного ассистента. Ответь одной строкой: ' +
      'HAIKU|SONNET|OPUS, затем « — » и причина до 8 слов по-русски. ' +
      'HAIKU: переименовать, поправить текст, найти файл, мелкий вопрос. ' +
      'SONNET: обычная разработка, правка функции, отладка одного места. ' +
      'OPUS: архитектура, большие изменения во многих файлах, сложная отладка, проектирование.',
    prompt: text.slice(0, 4000),
  })
  if (!r.isAnswered) return guess(text)
  const m = /(HAIKU|SONNET|OPUS)\s*[—-]?\s*(.*)/i.exec(r.text)
  if (m === null) return guess(text)
  return { tier: (m[1] ?? 'SONNET').toLowerCase() as Tier, reason: (m[2] ?? '').trim() || 'оценка Haiku' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router', description: 'Выбор модели по сложности: /router on | off | haiku | sonnet | opus' })
    const c = await read($, choice)
    if (c !== null && (await read($, isOn))) $.ui.status(`Модель: ${LABEL[c.tier]}`)
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'выкл') {
      await update($, isOn, () => false)
      $.ui.status(undefined)
      return { text: 'Выбор модели выключен: работает модель сессии (/model).' }
    }
    if (arg === 'on' || arg === 'вкл') {
      await update($, isOn, () => true)
      return { text: 'Выбор модели включён: каждая задача оценивается заново.' }
    }
    if (arg === 'haiku' || arg === 'sonnet' || arg === 'opus') {
      await update($, choice, () => ({ tier: arg, reason: 'выбрано вручную', prompt: '' }))
      $.ui.status(`Модель: ${LABEL[arg]}`)
      return { text: `Следующие ответы — на ${LABEL[arg]}, пока не придёт новая задача.` }
    }
    const c = await read($, choice)
    const on_ = await read($, isOn)
    return {
      text: `Выбор модели ${on_ ? 'включён' : 'выключен'}. ` +
        (c === null ? 'Задач ещё не было.' : `Последний выбор: ${LABEL[c.tier]} — ${c.reason}.`) +
        '\nКоманды: /router on, /router off, /router haiku|sonnet|opus',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const isPlain = e.command === undefined && e.isMeta !== true && e.origin.kind === 'composer' && e.text.trim() !== ''
    if (!isPlain || !(await read($, isOn))) return next(e)
    const { tier, reason } = await classify($, e.text)
    const c: Choice = { tier, reason, prompt: e.text.slice(0, 80) }
    await update($, choice, () => c)
    $.ui.status(`Модель: ${LABEL[tier]} — ${reason}`)
    return next(e)
  })

  // Каждый запрос основного диалога уходит на выбранную модель.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await read($, isOn))) return yield* next(e)
    const c = await read($, choice)
    if (c === null) return yield* next(e)
    return yield* next({ ...e, model: c.tier })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, choice)
    if (e.props.hasSurvey || c === null || !(await read($, isOn))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>Модель: </Text>
        <Text bold color={c.tier === 'opus' ? 'magenta' : c.tier === 'sonnet' ? 'blue' : 'green'}>{LABEL[c.tier]}</Text>
        <Text dimColor> — {c.reason}</Text>
      </Box>
    )
  })
}

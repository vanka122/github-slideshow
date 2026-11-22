import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const spend = atom({ plugin: 'helpers', key: 'spend' } as const, null, { shape: 'spend-1' })
const hasAnswer = atom({ plugin: 'helpers', key: 'hasAnswer' } as const, false)

// Команды, после которых работу не вернуть без сохранения.
const RISKY = [
  /\brm\s+-\w*r/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+clean\s+-\w*f/i,
  /\bgit\s+push\s+(-f|--force)/i,
  /\bgit\s+rebase\b/i,
]
const BIG_EDIT = 4000 // символов в одной перезаписи файла

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

// Траты за день: сумма по всем сессиям этого дня, хранится между сессиями.
async function refreshSpend($: EngineInterface) {
  const day = today(await $.clock.now())
  const id = await $.session.id()
  const { cost } = await $.session.usage()
  const key = `spend:${day}`
  const perSession = ((await $.store.get(key)) as Record<string, number> | undefined) ?? {}
  const next = { ...perSession, [id]: cost?.usd ?? 0 }
  await $.store.set(key, next)
  const usd = Object.values(next).reduce((a, b) => a + b, 0)
  await update($, spend, () => ({ day, usd }))
  $.ui.status(`За сегодня: $${usd.toFixed(2)}`)
}

async function remindSave($: EngineInterface, what: string) {
  $.ui.toast(`Большое изменение: ${what}. Сначала сохрани работу — попроси «сделай коммит».`)
  await $.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: `Мод helpers: впереди большое изменение (${what}). Если в репозитории есть несохранённая работа и пользователь не просил иначе, сначала предложи сделать коммит.`,
        },
      ],
    },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spend', description: 'Сколько потрачено за сегодня' })
    const done = await next(e)
    await refreshSpend($).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'spend' }, async $ => {
    await refreshSpend($)
    const s = await read($, spend)
    return {
      text: `Потрачено за ${s?.day ?? 'сегодня'}: $${(s?.usd ?? 0).toFixed(2)} (оценка по всем сессиям этого дня, не счёт).`,
      isTextDisplayOnly: true,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, hasAnswer, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await refreshSpend($).catch(() => undefined)
    if (e.reason === 'answer') await update($, hasAnswer, () => true)
    return done
  })

  // Напоминание сохранить работу перед большим изменением.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (RISKY.some(r => r.test(e.command))) await remindSave($, e.command.slice(0, 60)).catch(() => undefined)
    return next(e)
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (e.content.length > BIG_EDIT) await remindSave($, `перезапись ${e.file_path}`).catch(() => undefined)
    return next(e)
  })

  // Кнопка «Следующий шаг» после каждого ответа.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, hasAnswer))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, spend)
    return (
      <Box gap={1}>
        <Button
          key="next-step"
          label="Следующий шаг →"
          onPress={() =>
            $.prompt.submit({ text: 'Какой следующий шаг? Предложи один, самый полезный, и сделай его, если он безопасен.' })
          }
        />
        {s !== null && <Text dimColor>за сегодня ${s.usd.toFixed(2)}</Text>}
      </Box>
    )
  })
}

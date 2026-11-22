import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pipeline, Stage, TeamMessage } from '../types'

const PANE = 'team'
const TITLE = 'Команда'
const messages = atom({ plugin: 'team', key: 'messages' } as const, [], { shape: 'msg-1' })
const pipeline = atom({ plugin: 'team', key: 'pipeline' } as const, null, { shape: 'pipe-1' })

const ROLES: { role: Stage['role']; title: string; brief: (input: string) => string }[] = [
  {
    role: 'search',
    title: '1. Поиск компаний',
    brief: q =>
      `Ты — участник команды, роль «Поиск». Найди компании по запросу: «${q}». ` +
      'Пользуйся веб-поиском. Верни список из 5–10 компаний: название, адрес или город, сайт/соцсети, ' +
      'публичный контакт (если есть) и одна строка, чем компания примечательна. Не выдумывай данные: ' +
      'если чего-то не нашёл, так и напиши. Ответ — только список.',
  },
  {
    role: 'write',
    title: '2. Письма',
    brief: list =>
      'Ты — участник команды, роль «Письма». Предыдущий участник передал список компаний:\n\n' +
      `${list}\n\nНапиши каждой компании короткое (до 120 слов) персональное письмо на русском: ` +
      'тема, обращение, одна деталь именно про эту компанию, предложение, мягкий призыв ответить. ' +
      'Ничего не отправляй — только верни тексты, разделив их строкой «---».',
  },
  {
    role: 'review',
    title: '3. Проверка',
    brief: letters =>
      'Ты — участник команды, роль «Проверка». Вот письма от предыдущего участника:\n\n' +
      `${letters}\n\nПроверь каждое: персональное ли оно, нет ли выдуманных фактов, ошибок, ` +
      'навязчивости. Исправь, что нужно. Верни итог: таблицу «компания — статус (ок/исправлено) — что поправлено», ' +
      'а под ней финальные тексты писем.',
  },
]

// helpers
async function log($: EngineInterface, m: Omit<TeamMessage, 'at'>) {
  const at = await $.clock.now()
  await update($, messages, list => [...list, { ...m, at }].slice(-100))
}

async function setStage($: EngineInterface, index: number, patch: Partial<Stage>) {
  await update($, pipeline, (p): Pipeline =>
    p === null ? p : { ...p, stages: p.stages.map((s, i): Stage => (i === index ? { ...s, ...patch } : s)) },
  )
}

async function startStage($: EngineInterface, index: number, input: string) {
  const role = ROLES[index]
  if (role === undefined) return
  const spawned = await $.agent.spawn({ prompt: role.brief(input), description: role.title, name: `team-${role.role}` })
  if ('deny' in spawned && spawned.deny !== undefined) {
    await setStage($, index, { status: 'failed', result: String(spawned.deny) })
    $.ui.toast(`${role.title}: не запустился`)
    return
  }
  await setStage($, index, { status: 'running', agentId: (spawned as { agentId: string }).agentId })
  await log($, { from: index === 0 ? 'ты' : (ROLES[index - 1]?.title ?? ''), to: role.title, text: input.slice(0, 300) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'team', description: 'Открыть панель «Команда»' })
    await $.command.register({
      name: 'team-run',
      description: 'Запустить конвейер: /team-run кофейни и барбершопы в Казани',
    })
    return next(e)
  })

  on('command.run', { command: 'team' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Панель «Команда» открыта.' }
  })

  on('command.run', { command: 'team-run' }, async ($, e) => {
    const query = e.args.trim()
    if (query === '') {
      return { text: 'Напиши, кого искать: /team-run кофейни, студии и барбершопы в моём городе (укажи город)' }
    }
    await update($, pipeline, () => ({
      query,
      stages: ROLES.map(r => ({ role: r.role, title: r.title, status: 'waiting' as const })),
    }))
    await update($, messages, () => [])
    await $.ui.open({ id: PANE, title: TITLE })
    await startStage($, 0, query)
    return { text: `Команда запущена: «${query}». Ход работы — в панели «Команда».` }
  })

  // Когда участник закончил — передаём результат следующему.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) return done
    const p = await read($, pipeline)
    const index = p?.stages.findIndex(s => s.agentId === e.agentId) ?? -1
    if (p === null || index < 0 || p.stages[index]?.status !== 'running') return done

    const ok = e.reason === 'answer' && done.text.trim() !== ''
    await setStage($, index, { status: ok ? 'done' : 'failed', result: done.text })
    if (!ok) {
      $.ui.toast(`${ROLES[index]?.title}: не удалось (${e.reason})`)
      return done
    }
    if (index + 1 < ROLES.length) {
      await startStage($, index + 1, done.text)
    } else {
      await log($, { from: ROLES[index]?.title ?? '', to: 'ты', text: 'Итог готов.' })
      $.ui.toast('Команда закончила — итог в панели «Команда»')
      await $.session.append({
        message: {
          type: 'user',
          content: [{ type: 'text', text: `Итог команды по запросу «${p.query}»:\n\n${done.text}` }],
        },
      } as any)
    }
    return done
  })

  // Сообщения между сессиями и агентами (SendMessage и входящие от других сессий).
  on('session.send', async ($, e, next) => {
    await log($, { from: e.agentId ?? 'эта сессия', to: e.to, text: e.text.slice(0, 300) })
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message' || e.origin.kind === 'coordinator') {
      await log($, { from: 'другая сессия', to: e.agentId ?? 'эта сессия', text: e.text.slice(0, 300) })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, pipeline)
    const msgs = await read($, messages)
    const agents = await $.agent.list()
    const icon = (s: Stage['status']) =>
      s === 'done' ? '✓' : s === 'running' ? '…' : s === 'failed' ? '✗' : '·'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Конвейер</Text>
          {p === null ? (
            <Text dimColor>Не запущен. Команда: /team-run &lt;кого искать и где&gt;</Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>Запрос: {p.query}</Text>
              {p.stages.map(s => (
                <Text key={s.role} color={s.status === 'failed' ? 'red' : undefined} dimColor={s.status === 'waiting'}>
                  {icon(s.status)} {s.title}
                </Text>
              ))}
              {p.stages[2]?.status === 'done' && (
                <Box flexDirection="column">
                  <Text bold>Итог</Text>
                  <Text>{(p.stages[2]?.result ?? '').slice(0, 4000)}</Text>
                </Box>
              )}
              <Button key="reset" label="Очистить" onPress={() => update($, pipeline, () => null)} />
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          <Text bold>Участники ({agents.length})</Text>
          {agents.length === 0 && <Text dimColor>Пока никого.</Text>}
          {agents.slice(-10).map(a => (
            <Text key={a.id} dimColor={a.status !== 'running'}>
              {a.status === 'running' ? '●' : '○'} {a.name ?? a.description} — {a.status}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Сообщения</Text>
          {msgs.length === 0 && <Text dimColor>Сообщений пока нет.</Text>}
          {msgs.slice(-12).map(m => (
            <Text key={String(m.at)}>
              <Text dimColor>{m.from} → {m.to}: </Text>
              {m.text.replace(/\s+/g, ' ').slice(0, 140)}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

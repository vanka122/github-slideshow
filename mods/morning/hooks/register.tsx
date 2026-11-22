import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Mail, Project, Todo } from '../types'

const PANE = 'morning'
const TITLE = 'Доброе утро'
const STORE_KEY = 'board'
const EMPTY: Board = { todos: [], mail: [], projects: [] }
const board = atom({ plugin: 'morning', key: 'board' } as const, EMPTY, { shape: 'board-1' })

const REFRESH_PROMPT =
  'Обнови мою панель «Доброе утро». 1) Дела на сегодня: посмотри календарь и задачи в подключённых коннекторах, ' +
  'если они есть. 2) Письма, на которые надо ответить: посмотри почту в подключённом коннекторе, если он есть ' +
  '(только непрочитанные/ждущие ответа, без отправки чего-либо). 3) Проекты: посмотри git-репозитории в рабочей папке, ' +
  'оцени прогресс по TODO, открытым задачам и последним коммитам. Затем вызови инструмент mcp__morning__update_board ' +
  'с найденным. Чего нет — оставь как есть и коротко скажи, какой коннектор подключить.'

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

async function save($: EngineInterface, change: (b: Board) => Board) {
  const next = await update($, board, change)
  await $.store.set(STORE_KEY, next)
  return next
}

function fmt(b: Board): string {
  const t = b.todos.map((x, i) => `${i + 1}. [${x.isDone ? 'x' : ' '}] ${x.text}`).join('\n') || '—'
  const m = b.mail.map((x, i) => `${i + 1}. ${x.from}: ${x.subject}`).join('\n') || '—'
  const p = b.projects.map(x => `• ${x.name} — ${x.progress}%`).join('\n') || '—'
  return `Дела:\n${t}\n\nПисьма:\n${m}\n\nПроекты:\n${p}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gm', description: 'Открыть панель «Доброе утро»' })
    await $.command.register({ name: 'todo', description: 'Дела: /todo текст | /todo done 2 | /todo rm 2 | /todo clear' })
    await $.command.register({ name: 'mail', description: 'Письма: /mail От кого: тема | /mail rm 1' })
    await $.command.register({ name: 'project', description: 'Проекты: /project Название 40 | /project rm Название' })
    await $.tool.register({
      name: 'update_board',
      description:
        'Обновляет панель «Доброе утро» пользователя. Передай только те списки, которые нужно заменить: ' +
        'todos (дела на сегодня), mail (письма, ждущие ответа), projects (проекты с прогрессом 0–100).',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          todos: { type: 'array', items: { type: 'string' } },
          mail: {
            type: 'array',
            items: { type: 'object', properties: { from: { type: 'string' }, subject: { type: 'string' }, note: { type: 'string' } }, required: ['from', 'subject'] },
          },
          projects: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, progress: { type: 'number' }, next: { type: 'string' } }, required: ['name', 'progress'] },
          },
        },
      },
    })

    // Доска хранится между сессиями; выполненные дела прошлых дней убираем.
    const day = today(await $.clock.now())
    const stored = (await $.store.get(STORE_KEY)) as Board | undefined
    const base = stored ?? (await read($, board))
    await save($, () => ({ ...base, todos: base.todos.filter(t => !(t.isDone && t.day !== day)) }))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'gm' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Панель «Доброе утро» открыта.' }
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const a = e.args.trim()
    const day = today(await $.clock.now())
    const m = /^(done|rm|готово|удали)\s+(\d+)$/i.exec(a)
    let b: Board
    if (a === '') return { text: fmt(await read($, board)) }
    if (a === 'clear') b = await save($, x => ({ ...x, todos: x.todos.filter(t => !t.isDone) }))
    else if (m !== null) {
      const i = Number(m[2]) - 1
      const isRm = /rm|удали/i.test(m[1] ?? '')
      b = await save($, x => ({
        ...x,
        todos: isRm ? x.todos.filter((_, j) => j !== i) : x.todos.map((t, j) => (j === i ? { ...t, isDone: !t.isDone } : t)),
      }))
    } else b = await save($, x => ({ ...x, todos: [...x.todos, { text: a, isDone: false, day }] }))
    return { text: `Готово. Дел: ${b.todos.filter(t => !t.isDone).length} открытых.`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'mail' }, async ($, e) => {
    const a = e.args.trim()
    const rm = /^rm\s+(\d+)$/i.exec(a)
    if (a === '') return { text: fmt(await read($, board)) }
    if (rm !== null) {
      const i = Number(rm[1]) - 1
      await save($, x => ({ ...x, mail: x.mail.filter((_, j) => j !== i) }))
      return { text: 'Письмо убрано из списка.', isTextDisplayOnly: true }
    }
    const [from, ...rest] = a.split(':')
    const item: Mail = { from: (from ?? '').trim(), subject: rest.join(':').trim() || '(без темы)' }
    await save($, x => ({ ...x, mail: [...x.mail, item] }))
    return { text: `Добавлено письмо от ${item.from}.`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'project' }, async ($, e) => {
    const a = e.args.trim()
    const rm = /^rm\s+(.+)$/i.exec(a)
    if (rm !== null) {
      const name = (rm[1] ?? '').trim()
      await save($, x => ({ ...x, projects: x.projects.filter(p => p.name !== name) }))
      return { text: `Проект «${name}» убран.`, isTextDisplayOnly: true }
    }
    const m = /^(.+?)\s+(\d{1,3})%?$/.exec(a)
    if (m === null) return { text: 'Формат: /project Название 40' }
    const p: Project = { name: (m[1] ?? '').trim(), progress: Math.min(100, Number(m[2])) }
    await save($, x => ({ ...x, projects: [...x.projects.filter(q => q.name !== p.name), p] }))
    return { text: `Проект «${p.name}»: ${p.progress}%.`, isTextDisplayOnly: true }
  })

  on('tool.run', { tool: 'mcp__morning__update_board' }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as {
      todos?: string[]
      mail?: Mail[]
      projects?: Project[]
    }
    const now = await $.clock.now()
    const day = today(now)
    const b = await save($, x => ({
      todos: input.todos ? [...x.todos.filter(t => t.isDone && t.day === day), ...input.todos.map((text): Todo => ({ text, isDone: false, day }))] : x.todos,
      mail: input.mail ?? x.mail,
      projects: input.projects ? input.projects.map(p => ({ ...p, progress: Math.max(0, Math.min(100, Math.round(p.progress))) })) : x.projects,
      updatedAt: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
    }))
    await $.ui.open({ id: PANE, title: TITLE })
    return { result: `Панель обновлена.\n${fmt(b)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const open = b.todos.filter(t => !t.isDone).length
    const bar = (n: number) => '█'.repeat(Math.round(n / 10)) + '░'.repeat(10 - Math.round(n / 10))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Доброе утро! {open > 0 ? `Сегодня ${open} дел.` : 'Дел на сегодня нет.'}</Text>

        <Box flexDirection="column">
          <Text bold>Дела на сегодня</Text>
          {b.todos.length === 0 && <Text dimColor>Пусто. Добавь: /todo купить кофе</Text>}
          {b.todos.map((t, i) => (
            <Box key={`t${i}`}>
              <Button
                key={`tb${i}`}
                label={t.isDone ? '☑' : '☐'}
                onPress={() => save($, x => ({ ...x, todos: x.todos.map((y, j) => (j === i ? { ...y, isDone: !y.isDone } : y)) }))}
              />
              <Text dimColor={t.isDone} strikethrough={t.isDone}> {t.text}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Письма, ждущие ответа</Text>
          {b.mail.length === 0 && <Text dimColor>Нет. Добавь: /mail Анна: договор</Text>}
          {b.mail.map((m, i) => (
            <Box key={`m${i}`}>
              <Text>✉ {m.from} — {m.subject} </Text>
              <Button
                key={`mr${i}`}
                label="Ответить"
                onPress={() => $.prompt.fill({ text: `Помоги ответить на письмо от ${m.from} «${m.subject}».${m.note ? ' ' + m.note : ''}` })}
              />
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Проекты</Text>
          {b.projects.length === 0 && <Text dimColor>Нет. Добавь: /project Сайт кофейни 40</Text>}
          {b.projects.map((p, i) => (
            <Text key={`p${i}`}>
              {bar(p.progress)} {p.progress}% {p.name}
              {p.next ? <Text dimColor> — дальше: {p.next}</Text> : null}
            </Text>
          ))}
        </Box>

        <Box gap={1}>
          <Button key="refresh" label="Собрать с Claude" onPress={() => $.prompt.submit({ text: REFRESH_PROMPT })} />
          <Button key="clear" label="Убрать сделанное" onPress={() => save($, x => ({ ...x, todos: x.todos.filter(t => !t.isDone) }))} />
        </Box>
        {b.updatedAt && <Text dimColor>Обновлено Claude: {b.updatedAt} UTC</Text>}
      </Box>
    )
  })
}

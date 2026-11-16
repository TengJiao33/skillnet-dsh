export interface SkillDraft {
  sessionId: string
  reference: string
  skill: { name: string; path: string }
}

export function openSkillDraft(ctx: any, selection: SkillDraft) {
  const retained = ctx.sessions.retain(selection.sessionId, { source: 'skillnet-draft' })
  try {
    const result = ctx.conversation.input.requestDraftInitialization(retained.binding, {
      prompt: selection.reference,
      whenDraftExists: 'append',
    })
    if (result !== 'applied') throw new Error('目标对话正在提交消息，请稍后再添加技能。')
    ctx.uiWorkspace.openSession(selection.sessionId)
  } finally {
    retained.release()
  }
}

export interface AnalysisDraft { sessionId: string, prompt: string }

export function openAnalysisDraft(ctx: any, selection: AnalysisDraft) {
  const retained = ctx.sessions.retain(selection.sessionId, { source: 'skillnet-analysis-draft' })
  try {
    const result = ctx.conversation.input.requestDraftInitialization(retained.binding, {
      prompt: selection.prompt, whenDraftExists: 'append',
    })
    if (result !== 'applied') throw new Error('建图对话正在提交消息，请稍后重试。')
    ctx.uiWorkspace.openSession(selection.sessionId)
  } finally { retained.release() }
}

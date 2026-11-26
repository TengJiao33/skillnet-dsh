export interface SkillDraft {
  sessionId: string
  reference: string
  skill: { name: string; path: string }
}

export interface SkillDraftTarget {
  sourcePath: string
  skillId: string
  libraryName: string
  sessionId: string
  sessionTitle: string
}

function appendDraft(ctx: any, sessionId: string, prompt: string, source: string, blocked: string) {
  const retained = ctx.sessions.retain(sessionId, { source })
  try {
    const result = ctx.conversation.input.requestDraftInitialization(retained.binding, {
      prompt,
      whenDraftExists: 'append',
    })
    if (result !== 'applied') throw new Error(blocked)
    ctx.uiWorkspace.openSession(sessionId)
  } finally {
    retained.release()
  }
}

export function openSkillDraft(ctx: any, selection: SkillDraft) {
  appendDraft(ctx, selection.sessionId, selection.reference, 'skillnet-draft', '目标对话正在提交消息，请稍后再添加技能。')
}

export interface RouteDraft { sessionId: string, prompt: string }

export function openRouteDraft(ctx: any, selection: RouteDraft) {
  appendDraft(ctx, selection.sessionId, selection.prompt, 'skillnet-route-draft', '目标对话正在提交消息，请稍后再添加任务。')
}

export interface AnalysisDraft { sessionId: string, prompt: string }

export function openAnalysisDraft(ctx: any, selection: AnalysisDraft) {
  appendDraft(ctx, selection.sessionId, selection.prompt, 'skillnet-analysis-draft', '建图对话正在提交消息，请稍后重试。')
}

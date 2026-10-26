import { tablePrefix } from "./catalog.js";

export function editorialSlot(now, timezone) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export async function runEditorial(ctx, companyId, config, now = new Date()) {
  if (config.editorialEnabled !== true || !config.editorialIssueId || !config.editorialAgentId)
    return { status: "disabled" };
  const slot = editorialSlot(now, config.editorialTimezone ?? "America/Sao_Paulo");
  if (slot.time < (config.editorialTime ?? "09:00")) return { status: "not_due" };
  const pending = await ctx.db.query(
    `SELECT id FROM ${tablePrefix(ctx)}.social_posts WHERE company_id=$1 AND campaign='tessel-social-daily' AND status IN ('pending_approval','approved','scheduled','publishing','retry','unknown') LIMIT 1`,
    [companyId],
  );
  if (pending.length) return { status: "waiting_existing_post", postId: pending[0].id };
  const stateKey = { scopeKind: "company", scopeId: companyId, stateKey: `editorial:${slot.date}` };
  if (await ctx.state.get(stateKey)) return { status: "already_requested" };
  const issue = await ctx.issues.get(config.editorialIssueId, companyId);
  if (!issue || issue.assigneeAgentId !== config.editorialAgentId)
    throw new Error("EDITORIAL_OWNER_MISMATCH");
  const receipt = await ctx.issues.requestWakeup(issue.id, companyId, {
    reason: `Tessel Social Daily ${slot.date}: crie uma única proposta factual, consulte evidências de funcionalidades lançadas, reutilize Thainan para imagem, use as ferramentas Social Publisher e envie aprovação Telegram para a versão/destinos exatos. Use idempotencyKey social-daily:${slot.date}. dryRun obrigatório enquanto dryRunOnly estiver ativo. Sem publicação pública de teste.`,
    contextSource: "social_editorial",
    idempotencyKey: `social-daily:${companyId}:${slot.date}`,
  });
  await ctx.state.set(stateKey, { requestedAt: now.toISOString(), receipt });
  return { status: "requested", date: slot.date, receipt };
}

import { useState } from "react";
import { useHostNavigation, usePluginData, type PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";

type CatalogCommand = {
  name: string;
  description: string;
  source: "gateway" | "paperclip" | "provider";
  providerId: string | null;
};

type CommandCatalog = {
  commands: CatalogCommand[];
  botFatherLines: string[];
  omittedFromBotFather: number;
  commandsEnabled: boolean;
  guidance: { commandMenuUrl: string; botFatherUrl: string; botFatherDocsUrl: string };
};

const style = [
  ".tg-settings{color:var(--foreground);max-width:58rem;font:inherit;line-height:1.55}",
  ".tg-settings h1,.tg-settings h2,.tg-settings p{margin:0}",
  ".tg-settings h1{font-size:1.45rem;letter-spacing:-.025em;font-weight:650}",
  ".tg-settings h2{font-size:1rem;font-weight:650}",
  ".tg-settings .intro{color:var(--muted-foreground);margin-top:.4rem}",
  ".tg-settings .panel{margin-top:1rem;padding:1rem;border:1px solid var(--border);border-radius:.7rem;background:var(--card)}",
  ".tg-settings .status{display:flex;gap:.6rem;align-items:center;padding:.7rem .85rem;border:1px solid var(--border);border-radius:.5rem;background:var(--muted);margin-top:.9rem}",
  ".tg-settings .dot{width:.55rem;height:.55rem;border-radius:50%;background:#b7791f;flex:none}",
  ".tg-settings .muted{color:var(--muted-foreground);font-size:.85rem}",
  ".tg-settings ol{padding-left:1.3rem;margin:.65rem 0 0}.tg-settings li{padding:.18rem 0}",
  ".tg-settings a{color:var(--primary);text-underline-offset:3px}",
  ".tg-settings .commands{font: .82rem ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--muted);padding:.8rem;border-radius:.5rem;margin:.7rem 0}",
  ".tg-settings button{font:inherit;border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:.45rem;padding:.48rem .7rem;cursor:pointer}",
  ".tg-settings button:hover{background:var(--accent)}.tg-settings button:focus-visible,.tg-settings a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
  ".tg-settings table{border-collapse:collapse;width:100%;margin-top:.65rem;font-size:.85rem}.tg-settings th,.tg-settings td{text-align:left;padding:.55rem .45rem;border-bottom:1px solid var(--border);vertical-align:top}.tg-settings th{color:var(--muted-foreground);font-weight:550}.tg-settings code{font-size:.85em}",
  "@media(max-width:560px){.tg-settings .panel{padding:.8rem}.tg-settings table{font-size:.78rem}.tg-settings th,.tg-settings td{padding:.45rem .25rem}}",
].join("\n");

export function TelegramCommandsSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const catalog = usePluginData<CommandCatalog>("telegram-command-catalog", { companyId });
  const hostNavigation = useHostNavigation();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCommands() {
    if (!catalog.data) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(catalog.data.botFatherLines.join("\n"));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <section className="tg-settings">
      <style>{style}</style>
      <header>
        <h1>Comandos do Telegram</h1>
        <p className="intro">Catálogo de comandos e instruções do BotFather para esta empresa Paperclip.</p>
      </header>

      {!companyId ? <div className="panel">Selecione uma empresa para carregar o catálogo de comandos.</div> : null}
      {catalog.loading ? <div className="panel">Carregando o catálogo desta empresa…</div> : null}
      {catalog.error ? <div className="panel" role="alert">Não foi possível carregar o catálogo: {catalog.error.message}</div> : null}

      {catalog.data ? <>
        <div className="status" role="status">
          <span className="dot" aria-hidden="true" />
          <div>
            <strong>Esta página não verifica o recebimento de comandos pelo bot.</strong>
            <div className="muted">Após configurar o bot, valide o acesso enviando <code>/help</code>. O menu só mostra sugestões e não altera as regras de autorização.</div>
          </div>
        </div>

        <section className="panel" aria-labelledby="botfather-heading">
          <h2 id="botfather-heading">Configure ou atualize o menu do bot</h2>
          <ol>
            <li>Abra <a href={catalog.data.guidance.botFatherUrl} target="_blank" rel="noreferrer">@BotFather</a> e escolha o bot conectado a esta empresa em <code>/mybots</code>. Use <code>/newbot</code> somente se ainda não tiver criado um bot.</li>
            <li>No Paperclip, configure esse mesmo bot no conector nativo do Telegram e vincule o Founder Liaison. <a {...hostNavigation.linkProps("/company/settings/instance/plugins/journey-studios.founder-comms-router")}>Abra as configurações deste plugin</a> para editar a configuração da empresa.</li>
            <li>Confira <code>liaisonAgentId</code>, <code>founderUserId</code>, <code>commandsEnabled</code>, <code>chatChannels</code> e <code>commandProviderIds</code> no formulário existente; o campo do token continua no conector Telegram nativo.</li>
            <li>No @BotFather, envie <code>/setcommands</code>, escolha exatamente esse bot e cole as linhas abaixo sem adicionar a barra inicial.</li>
            <li>Atualize a lista após mudar provedores permitidos ou reconectar o bot. O Paperclip pode restaurar o menu padrão durante a reconexão.</li>
          </ol>
          <p className="muted" style={{ marginTop: ".65rem" }}>
            O Telegram usa esta lista para exibir sugestões. Um comando no menu não autoriza o usuário nem garante que o Paperclip o aceite neste momento.
          </p>
          <pre className="commands" aria-label="Lista de comandos para o BotFather">{catalog.data.botFatherLines.join("\n") || "Nenhum comando disponível."}</pre>
          {catalog.data.omittedFromBotFather > 0 ? <p className="muted" role="status" style={{ marginTop: ".6rem" }}>
            O menu do Telegram aceita até 100 comandos; {catalog.data.omittedFromBotFather} itens adicionais do catálogo não aparecem nesta lista.
          </p> : null}
          <button type="button" onClick={copyCommands} disabled={!catalog.data.botFatherLines.length}>
            Copiar linhas de comandos
          </button>
          {copyStatus !== "idle" ? <p className="muted" role="status" aria-live="polite" style={{ marginTop: ".4rem" }}>
            {copyStatus === "copied" ? "Linhas copiadas." : "Não foi possível copiar automaticamente. Selecione e copie as linhas acima."}
          </p> : null}
          <p className="muted" style={{ marginTop: ".65rem" }}>
            Consulte a <a href={catalog.data.guidance.commandMenuUrl} target="_blank" rel="noreferrer">documentação do menu de comandos</a> e as <a href={catalog.data.guidance.botFatherDocsUrl} target="_blank" rel="noreferrer">instruções do BotFather</a>.
          </p>
        </section>

        <section className="panel" aria-labelledby="catalog-heading">
          <h2 id="catalog-heading">Catálogo de comandos desta empresa</h2>
          <p className="muted" style={{ marginTop: ".25rem" }}>
            {catalog.data.commandsEnabled ? "Comandos diretos estão ativados na configuração do plugin desta empresa." : "Comandos diretos estão desativados na configuração do plugin desta empresa."}
            {" Os comandos de provedores vêm somente da lista permitida desta empresa."}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th scope="col">Comando</th><th scope="col">Descrição</th><th scope="col">Origem</th></tr></thead>
              <tbody>{catalog.data.commands.map((command) => <tr key={`${command.name}:${command.providerId ?? command.source}`}>
                <td><code>/{command.name}</code></td>
                <td>{command.description}</td>
                <td>{command.source === "provider" ? command.providerId : command.source === "paperclip" ? "Paperclip" : "Telegram Gateway"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      </> : null}
    </section>
  );
}

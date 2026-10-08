/** Native commands retained by Paperclip's Telegram adapter. */
export const NATIVE_TELEGRAM_COMMANDS = [
  { name: "status", description: "Consultar tarefa atual", source: "paperclip" },
  { name: "task", description: "Iniciar tarefa com uma solicitação", source: "paperclip" },
  { name: "new", description: "Criar uma nova tarefa", source: "paperclip" },
  { name: "close", description: "Encerrar a conversa", source: "paperclip" },
  { name: "start", description: "Iniciar conversa", source: "paperclip" },
];

export const TELEGRAM_COMMAND_GUIDANCE = {
  commandMenuUrl: "https://core.telegram.org/bots/features#commands",
  botFatherDocsUrl: "https://core.telegram.org/bots/features#botfather",
  botFatherUrl: "https://t.me/BotFather",
};

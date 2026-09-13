interface Props {
  typingAgentIds: string[];
  contactIsTyping: boolean;
}

export default function TypingIndicator({ typingAgentIds, contactIsTyping }: Props) {
  const show = typingAgentIds.length > 0 || contactIsTyping;
  if (!show) return null;

  return (
    <div className="px-4 py-1 text-xs text-gray-400 italic">
      {contactIsTyping
        ? '对方正在输入...'
        : `${typingAgentIds.length} 名客服正在输入...`}
    </div>
  );
}

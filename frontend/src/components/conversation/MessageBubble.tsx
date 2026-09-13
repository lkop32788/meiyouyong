import type { Message } from '../../types';

const STATUS_ICON: Record<string, string> = {
  pending:   '🕐',
  sent:      '✓',
  delivered: '✓✓',
  read:      '✓✓',
  failed:    '✗',
};

interface Props {
  message: Message;
  onRetry?: (msg: Message) => void;
}

export default function MessageBubble({ message, onRetry }: Props) {
  const isOutbound = message.direction === 'outbound';
  const isSystem   = message.senderType === 'system';

  if (isSystem) {
    return (
      <div className="text-center my-2">
        <span className="text-xs text-gray-400 italic">{renderContent(message)}</span>
      </div>
    );
  }

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'} mb-1`}>
      <div
        className={[
          'max-w-[70%] rounded-2xl px-3 py-2 text-sm',
          isOutbound
            ? 'bg-brand-600 text-white rounded-br-sm'
            : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm',
        ].join(' ')}
      >
        {renderContent(message)}

        {isOutbound && (
          <div className={`flex items-center justify-end gap-1 mt-1 text-xs ${message.status === 'read' ? 'text-blue-200' : 'text-white/60'}`}>
            <span>{STATUS_ICON[message.status] ?? ''}</span>
            {message.status === 'failed' && onRetry && (
              <button
                onClick={() => onRetry(message)}
                className="text-red-300 underline ml-1"
              >
                重新发送
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function renderContent(message: Message) {
  const { contentType, content } = message;

  switch (contentType) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words">{content.body as string}</p>;

    case 'image':
      return (
        <img
          src={content.url as string}
          alt="image"
          loading="lazy"
          className="rounded max-w-full max-h-60 object-cover cursor-pointer"
        />
      );

    case 'audio':
      return (
        <audio controls src={content.url as string} className="max-w-full">
          您的浏览器不支持音频播放。
        </audio>
      );

    case 'video':
      return (
        <video controls src={content.url as string} className="max-w-full max-h-60 rounded">
          您的浏览器不支持视频播放。
        </video>
      );

    case 'file':
      return (
        <a
          href={content.url as string}
          download={content.filename as string}
          className="flex items-center gap-2 underline"
        >
          <span>📎</span>
          <span className="truncate">{(content.filename as string) ?? 'file'}</span>
        </a>
      );

    case 'location': {
      const lat = content.latitude;
      const lng = content.longitude;
      return (
        <a
          href={`https://maps.google.com?q=${lat},${lng}`}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          📍 查看位置
        </a>
      );
    }

    case 'sticker':
      return <img src={content.url as string} alt="sticker" className="w-24 h-24 object-contain" />;

    default:
      return <p className="italic text-xs opacity-70">[不支持的消息类型：{contentType}]</p>;
  }
}

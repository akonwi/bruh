import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

const remarkPlugins = [remarkGfm, remarkBreaks]

type MessageMarkdownTone = 'assistant' | 'user' | 'system'

interface MessageMarkdownProps {
  content: string
  tone?: MessageMarkdownTone
  className?: string
}

export function MessageMarkdown({
  content,
  tone = 'assistant',
  className,
}: MessageMarkdownProps) {
  return (
    <div
      className={cn(
        'transcript-markdown prose prose-sm max-w-none break-words',
        tone === 'user'
          ? 'transcript-markdown-user'
          : tone === 'system'
            ? 'transcript-markdown-system'
            : 'transcript-markdown-assistant',
        className,
      )}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        components={{
          a: ({ href, ...props }) => (
            <a
              {...props}
              href={href}
              rel={href ? 'noreferrer noopener' : undefined}
              target={href ? '_blank' : undefined}
            />
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
